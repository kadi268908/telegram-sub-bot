// src/config/database.js
// MongoDB connection setup with reconnection logic

const mongoose = require('mongoose');
const dns = require('dns');
const logger = require('../utils/logger');

const normalizeMongoUri = (value) => {
  if (!value) return value;

  let normalized = String(value).trim();

  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }

  if (normalized.startsWith('MONGO_URI=')) {
    normalized = normalized.slice('MONGO_URI='.length).trim();
  }

  return normalized;
};

const connectDB = async () => {
  try {
    const dnsServersRaw = process.env.MONGO_DNS_SERVERS;
    if (dnsServersRaw) {
      const dnsServers = dnsServersRaw
        .split(',')
        .map((server) => server.trim())
        .filter(Boolean);

      if (dnsServers.length > 0) {
        dns.setServers(dnsServers);
        logger.info(`Using custom DNS servers for MongoDB lookup: ${dnsServers.join(', ')}`);
      }
    }

    const mongoUri = normalizeMongoUri(process.env.MONGO_URI);

    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    logger.info(`MongoDB Connected: ${conn.connection.host}`);

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected. Attempting reconnect...');
      setTimeout(connectDB, 5000);
    });

    mongoose.connection.on('error', (err) => {
      logger.error(`MongoDB error: ${err.message}`);
    });

  } catch (error) {
    logger.error(`MongoDB connection failed: ${error.message}`);
    if (error.message.includes('querySrv ECONNREFUSED')) {
      logger.error('SRV DNS lookup failed. Set MONGO_DNS_SERVERS in .env (example: 8.8.8.8,1.1.1.1) and retry.');
    }
    process.exit(1);
  }
};

module.exports = connectDB;
