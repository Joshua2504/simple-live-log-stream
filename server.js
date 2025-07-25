const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { spawn } = require('child_process');

// Enhanced logging utility
class Logger {
  static formatTimestamp() {
    return new Date().toISOString();
  }
  
  static log(level, message, data = {}) {
    const timestamp = this.formatTimestamp();
    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      message,
      ...data
    };
    
    // Console output for Docker logs
    console.log(JSON.stringify(logEntry));
  }
  
  static info(message, data) {
    this.log('info', message, data);
  }
  
  static warn(message, data) {
    this.log('warn', message, data);
  }
  
  static error(message, data) {
    this.log('error', message, data);
  }
  
  static debug(message, data) {
    this.log('debug', message, data);
  }
}

// Function to obfuscate IP addresses in log data
function obfuscateIPAddresses(logData) {
  // IPv4 pattern: matches standard IPv4 addresses
  const ipv4Pattern = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;
  
  // IPv6 pattern: matches standard IPv6 addresses
  const ipv6Pattern = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}\b|\b(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}\b|\b(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}\b|\b[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}\b|\b::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:\b/g;
  
  // Replace IPv4 addresses with obfuscated version (show first 2 octets, mask the rest)
  let obfuscated = logData.replace(ipv4Pattern, (match) => {
    const parts = match.split('.');
    return `${parts[0]}.${parts[1]}.xxx.xxx`;
  });
  
  // Replace IPv6 addresses with obfuscated version (show first 2 segments, mask the rest)
  obfuscated = obfuscated.replace(ipv6Pattern, (match) => {
    if (match.includes('::')) {
      const firstPart = match.split('::')[0];
      const segments = firstPart.split(':');
      if (segments.length >= 2) {
        return `${segments[0]}:${segments[1]}::xxxx:xxxx:xxxx:xxxx`;
      } else {
        return `${segments[0]}:xxxx::xxxx:xxxx:xxxx:xxxx`;
      }
    } else {
      const parts = match.split(':');
      return `${parts[0]}:${parts[1]}:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx`;
    }
  });
  
  return obfuscated;
}

const server = http.createServer((req, res) => {
  Logger.debug('HTTP request received', { 
    method: req.method, 
    url: req.url, 
    userAgent: req.headers['user-agent'],
    remoteAddress: req.connection.remoteAddress 
  });
  
  if (req.url === '/') {
    const file = path.join(__dirname, 'index.html');
    Logger.debug('Serving index.html');
    res.setHeader('Content-Type', 'text/html');
    fs.createReadStream(file).pipe(res);
  } else if (req.url === '/app.js') {
    const file = path.join(__dirname, 'app.js');
    Logger.debug('Serving app.js');
    res.setHeader('Content-Type', 'application/javascript');
    fs.createReadStream(file).pipe(res);
  } else {
    Logger.warn('404 - File not found', { url: req.url });
    res.writeHead(404);
    res.end();
  }
});

// Global state for managing single log tail process and multiple clients
class LogBroadcaster {
  constructor() {
    this.clients = new Set();
    this.tail = null;
    this.messageBuffer = [];
    this.bufferTimeout = null;
    this.isStarted = false;
    this.BUFFER_SIZE = 50; // Increased from 5 to 50 for better throughput
    this.BUFFER_DELAY = 50; // Reduced from 100ms to 50ms for faster transmission
  }

  addClient(ws, clientInfo) {
    this.clients.add({ ws, clientInfo, messagesSent: 0, totalBytesSent: 0 });
    
    Logger.info('Client added to broadcaster', {
      ...clientInfo,
      totalClients: this.clients.size
    });

    // Tail process is always running, no need to start it here
  }

  removeClient(ws, clientInfo) {
    // Find and remove the client
    for (const client of this.clients) {
      if (client.ws === ws) {
        const sessionStats = {
          totalMessagesSent: client.messagesSent,
          totalBytesSent: client.totalBytesSent,
          sessionDuration: Date.now() - new Date(clientInfo.connectionTime).getTime()
        };

        Logger.info('Client removed from broadcaster', {
          ...clientInfo,
          ...sessionStats,
          remainingClients: this.clients.size - 1
        });

        this.clients.delete(client);
        break;
      }
    }

    // Keep the tail process running even if no clients remain
    // The process will be stopped only on server shutdown
  }

  startTailProcess() {
    if (this.isStarted) return;

    this.tail = spawn('bash', ['-c',
      `find /mnt/vhosts/*/logs/ -type f ! -name "*.gz" -exec tail -f -n 0 {} + | ts '[%Y-%m-%d %H:%M:%S]'`
    ]);

    this.isStarted = true;

    Logger.info('Global log tail process started', { 
      command: 'tail -f -n 0 with find (live logs only)',
      pid: this.tail.pid,
      clientCount: this.clients.size
    });

    this.tail.stdout.on('data', (data) => {
      const logData = data.toString().trim();
      if (!logData) return;
      
      Logger.debug('Raw log data received for broadcast', { 
        dataLength: logData.length,
        pid: this.tail.pid,
        activeClients: this.clients.size
      });
      
      // Add to buffer instead of sending immediately
      this.messageBuffer.push(logData);
      
      // Send buffer when it's full or after timeout
      if (this.messageBuffer.length >= this.BUFFER_SIZE) {
        clearTimeout(this.bufferTimeout);
        this.broadcastBufferedMessages();
      } else if (!this.bufferTimeout) {
        this.bufferTimeout = setTimeout(() => this.broadcastBufferedMessages(), this.BUFFER_DELAY);
      }
    });

    this.tail.stderr.on('data', (data) => {
      Logger.error('Global log stream error from tail process', { 
        error: data.toString(),
        pid: this.tail.pid,
        clientCount: this.clients.size
      });
    });

    this.tail.on('close', (code, signal) => {
      Logger.warn('Global log tail process closed', { 
        code, 
        signal, 
        pid: this.tail.pid,
        clientCount: this.clients.size
      });
      this.isStarted = false;
    });

    this.tail.on('error', (error) => {
      Logger.error('Global log tail process error', { 
        error: error.message,
        pid: this.tail.pid,
        clientCount: this.clients.size
      });
      this.isStarted = false;
    });
  }

  stopTailProcess() {
    if (!this.isStarted || !this.tail) return;

    clearTimeout(this.bufferTimeout);
    this.bufferTimeout = null;

    if (!this.tail.killed) {
      this.tail.kill();
      Logger.info('Global tail process stopped - no clients remaining', { 
        pid: this.tail.pid 
      });
    }

    this.isStarted = false;
    this.tail = null;
    this.messageBuffer = [];
  }

  broadcastBufferedMessages() {
    if (this.messageBuffer.length === 0) {
      this.bufferTimeout = null;
      return;
    }

    const batchedData = this.messageBuffer.join('\n');
    const obfuscatedData = obfuscateIPAddresses(batchedData);
    const dataSize = Buffer.byteLength(obfuscatedData, 'utf8');
    
    let successfulSends = 0;
    let failedSends = 0;

    // Broadcast to all connected clients
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(obfuscatedData);
          client.messagesSent += this.messageBuffer.length;
          client.totalBytesSent += dataSize;
          successfulSends++;
        } catch (error) {
          Logger.error('Failed to send to client', {
            error: error.message,
            clientAddress: client.clientInfo.remoteAddress
          });
          failedSends++;
        }
      } else {
        // Client connection is closed, will be cleaned up elsewhere
        failedSends++;
      }
    }

    // Enhanced logging with broadcast metrics
    Logger.debug('Log batch broadcast to clients', {
      linesInBatch: this.messageBuffer.length,
      batchSizeBytes: dataSize,
      totalClients: this.clients.size,
      successfulSends,
      failedSends,
      tailPid: this.tail ? this.tail.pid : 'null'
    });
    
    this.messageBuffer = [];
    this.bufferTimeout = null;
  }
}

// Create global broadcaster instance
const logBroadcaster = new LogBroadcaster();

const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: {
    // Enable compression to reduce bandwidth
    deflate: true,
    threshold: 1024,
    concurrencyLimit: 10,
  }
});

wss.on('connection', function connection(ws, req) {
  const clientInfo = {
    remoteAddress: req.connection.remoteAddress,
    userAgent: req.headers['user-agent'],
    connectionTime: new Date().toISOString()
  };
  
  Logger.info('WebSocket client connected', clientInfo);

  // Add client to the global broadcaster
  logBroadcaster.addClient(ws, clientInfo);

  ws.on('close', (code, reason) => {
    Logger.info('WebSocket client disconnected', {
      ...clientInfo,
      closeCode: code,
      closeReason: reason
    });
    
    // Remove client from broadcaster
    logBroadcaster.removeClient(ws, clientInfo);
  });

  ws.on('error', (error) => {
    Logger.error('WebSocket connection error', {
      error: error.message,
      clientAddress: clientInfo.remoteAddress,
      errorCode: error.code
    });
    
    // Remove client from broadcaster
    logBroadcaster.removeClient(ws, clientInfo);
  });
});

const PORT = 9123;

// Handle process termination gracefully
process.on('SIGTERM', () => {
  Logger.info('Received SIGTERM, shutting down gracefully');
  
  // Stop the global tail process
  logBroadcaster.stopTailProcess();
  
  server.close(() => {
    Logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  Logger.info('Received SIGINT, shutting down gracefully');
  
  // Stop the global tail process
  logBroadcaster.stopTailProcess();
  
  server.close(() => {
    Logger.info('HTTP server closed');
    process.exit(0);
  });
});

server.listen(PORT, () => {
  Logger.info('Live log stream server started', {
    port: PORT,
    nodeVersion: process.version,
    platform: process.platform,
    pid: process.pid,
    url: `http://localhost:${PORT}`,
    maxClients: 'unlimited (shared tail process)',
    features: ['IP obfuscation', 'Log broadcasting', 'Compression', 'Graceful shutdown']
  });
  
  // Start the tail process immediately when server starts
  logBroadcaster.startTailProcess();
});

// Periodic health check and cleanup
setInterval(() => {
  // Clean up any closed connections that weren't properly removed
  const activeBefore = logBroadcaster.clients.size;
  
  for (const client of logBroadcaster.clients) {
    if (client.ws.readyState !== WebSocket.OPEN) {
      logBroadcaster.clients.delete(client);
      Logger.debug('Cleaned up closed client connection', {
        clientAddress: client.clientInfo.remoteAddress,
        readyState: client.ws.readyState
      });
    }
  }
  
  const activeAfter = logBroadcaster.clients.size;
  const cleaned = activeBefore - activeAfter;
  
  if (cleaned > 0 || activeAfter > 0) {
    Logger.info('Health check completed', {
      activeClients: activeAfter,
      cleanedConnections: cleaned,
      tailProcessActive: logBroadcaster.isStarted,
      tailPid: logBroadcaster.tail ? logBroadcaster.tail.pid : null
    });
  }
  
  // Keep tail process running even with no clients for immediate response
  // when new clients connect
}, 30000); // Every 30 seconds
