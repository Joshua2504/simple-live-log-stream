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

  let messageBuffer = [];
  let bufferTimeout = null;
  let messagesSent = 0;
  let totalBytesSent = 0;
  const BUFFER_SIZE = 5;
  const BUFFER_DELAY = 100; // ms

  const tail = spawn('bash', ['-c',
    `find /mnt/vhosts/*/logs/ -type f ! -name "*.gz" -exec tail -f -n 0 {} + | ts '[%Y-%m-%d %H:%M:%S]'`
  ]);

  Logger.info('Log tail process started', { 
    command: 'tail -f -n 0 with find (live logs only)',
    pid: tail.pid 
  });

  function sendBufferedMessages() {
    if (messageBuffer.length > 0 && ws.readyState === WebSocket.OPEN) {
      const batchedData = messageBuffer.join('\n');
      const obfuscatedData = obfuscateIPAddresses(batchedData);
      const dataSize = Buffer.byteLength(obfuscatedData, 'utf8');
      
      ws.send(obfuscatedData);
      
      messagesSent += messageBuffer.length;
      totalBytesSent += dataSize;
      
      // Enhanced logging with metrics
      Logger.debug('Log batch sent to client', {
        linesInBatch: messageBuffer.length,
        batchSizeBytes: dataSize,
        totalMessagesSent: messagesSent,
        totalBytesSent: totalBytesSent,
        clientAddress: clientInfo.remoteAddress
      });
      
      messageBuffer = [];
    }
    bufferTimeout = null;
  }

  tail.stdout.on('data', (data) => {
    const logData = data.toString().trim();
    if (!logData) return;
    
    Logger.debug('Raw log data received', { 
      dataLength: logData.length,
      pid: tail.pid 
    });
    
    // Add to buffer instead of sending immediately
    messageBuffer.push(logData);
    
    // Send buffer when it's full or after timeout
    if (messageBuffer.length >= BUFFER_SIZE) {
      clearTimeout(bufferTimeout);
      sendBufferedMessages();
    } else if (!bufferTimeout) {
      bufferTimeout = setTimeout(sendBufferedMessages, BUFFER_DELAY);
    }
  });

  tail.stderr.on('data', (data) => {
    Logger.error('Log stream error from tail process', { 
      error: data.toString(),
      pid: tail.pid 
    });
  });

  tail.on('close', (code, signal) => {
    Logger.warn('Log tail process closed', { 
      code, 
      signal, 
      pid: tail.pid 
    });
  });

  tail.on('error', (error) => {
    Logger.error('Log tail process error', { 
      error: error.message,
      pid: tail.pid 
    });
  });

  ws.on('close', (code, reason) => {
    const sessionStats = {
      totalMessagesSent: messagesSent,
      totalBytesSent: totalBytesSent,
      sessionDuration: Date.now() - new Date(clientInfo.connectionTime).getTime(),
      closeCode: code,
      closeReason: reason
    };
    
    Logger.info('WebSocket client disconnected', {
      ...clientInfo,
      ...sessionStats
    });
    
    clearTimeout(bufferTimeout);
    if (tail && !tail.killed) {
      tail.kill();
      Logger.debug('Tail process killed for disconnected client', { pid: tail.pid });
    }
  });

  ws.on('error', (error) => {
    Logger.error('WebSocket connection error', {
      error: error.message,
      clientAddress: clientInfo.remoteAddress,
      errorCode: error.code
    });
    
    clearTimeout(bufferTimeout);
    if (tail && !tail.killed) {
      tail.kill();
      Logger.debug('Tail process killed due to WebSocket error', { pid: tail.pid });
    }
  });
});

const PORT = 9123;

// Handle process termination gracefully
process.on('SIGTERM', () => {
  Logger.info('Received SIGTERM, shutting down gracefully');
  server.close(() => {
    Logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  Logger.info('Received SIGINT, shutting down gracefully');
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
    url: `http://localhost:${PORT}`
  });
});
