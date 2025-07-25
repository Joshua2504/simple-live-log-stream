#!/usr/bin/env node

/**
 * Test script to verify multiple WebSocket connections work properly
 * This simulates multiple users connecting to the log stream server
 */

const WebSocket = require('ws');

const SERVER_URL = 'ws://localhost:9123';
const NUM_CLIENTS = 10;
const TEST_DURATION = 10000; // 10 seconds

console.log(`Testing ${NUM_CLIENTS} concurrent WebSocket connections...`);
console.log(`Server URL: ${SERVER_URL}`);
console.log(`Test duration: ${TEST_DURATION}ms\n`);

const clients = [];
let connectedClients = 0;
let totalMessagesReceived = 0;
let totalBytesReceived = 0;

function createClient(clientId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    const clientStats = {
      id: clientId,
      connected: false,
      messagesReceived: 0,
      bytesReceived: 0,
      connectTime: null,
      lastMessageTime: null
    };

    ws.on('open', () => {
      clientStats.connected = true;
      clientStats.connectTime = Date.now();
      connectedClients++;
      
      console.log(`✅ Client ${clientId} connected (${connectedClients}/${NUM_CLIENTS})`);
      
      if (connectedClients === NUM_CLIENTS) {
        console.log(`\n🎉 All ${NUM_CLIENTS} clients connected successfully!\n`);
      }
    });

    ws.on('message', (data) => {
      const messageSize = Buffer.byteLength(data);
      clientStats.messagesReceived++;
      clientStats.bytesReceived += messageSize;
      clientStats.lastMessageTime = Date.now();
      
      totalMessagesReceived++;
      totalBytesReceived += messageSize;
      
      // Log first message from each client
      if (clientStats.messagesReceived === 1) {
        console.log(`📨 Client ${clientId} received first message (${messageSize} bytes)`);
      }
    });

    ws.on('close', (code, reason) => {
      if (clientStats.connected) {
        connectedClients--;
      }
      console.log(`❌ Client ${clientId} disconnected (code: ${code})`);
    });

    ws.on('error', (error) => {
      console.error(`🚨 Client ${clientId} error:`, error.message);
      reject(error);
    });

    clients.push({ ws, stats: clientStats });
    resolve(clientStats);
  });
}

async function runTest() {
  const startTime = Date.now();
  
  try {
    // Create all clients
    console.log('Creating WebSocket connections...\n');
    const promises = [];
    for (let i = 1; i <= NUM_CLIENTS; i++) {
      promises.push(createClient(i));
    }
    
    await Promise.all(promises);
    
    // Wait for test duration
    console.log(`⏱️  Running test for ${TEST_DURATION}ms...\n`);
    await new Promise(resolve => setTimeout(resolve, TEST_DURATION));
    
    // Calculate statistics
    const endTime = Date.now();
    const testDuration = endTime - startTime;
    
    console.log('\n📊 TEST RESULTS:');
    console.log('='.repeat(50));
    console.log(`Test Duration: ${testDuration}ms`);
    console.log(`Clients Created: ${NUM_CLIENTS}`);
    console.log(`Max Concurrent: ${Math.max(...clients.map(c => c.stats.connected ? 1 : 0).reduce((acc, curr, i) => {
      acc[i] = (acc[i-1] || 0) + curr;
      return acc;
    }, []))}`);
    console.log(`Total Messages Received: ${totalMessagesReceived}`);
    console.log(`Total Bytes Received: ${(totalBytesReceived / 1024).toFixed(2)} KB`);
    console.log(`Average Messages per Client: ${(totalMessagesReceived / NUM_CLIENTS).toFixed(1)}`);
    console.log(`Messages per Second: ${(totalMessagesReceived / (testDuration / 1000)).toFixed(1)}`);
    
    console.log('\n📈 PER-CLIENT STATS:');
    clients.forEach(client => {
      const { stats } = client;
      const sessionDuration = stats.lastMessageTime ? 
        stats.lastMessageTime - stats.connectTime : 
        testDuration;
      
      console.log(`Client ${stats.id}: ${stats.messagesReceived} msgs, ${(stats.bytesReceived / 1024).toFixed(1)} KB, session: ${sessionDuration}ms`);
    });
    
    // Close all connections
    console.log('\n🔄 Closing all connections...');
    clients.forEach(client => {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.close();
      }
    });
    
    console.log('\n✅ Test completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Test interrupted by user');
  clients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.close();
    }
  });
  process.exit(0);
});

// Start the test
runTest().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('Test error:', error);
  process.exit(1);
});
