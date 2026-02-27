// src/index.js
// Main entry point — wires up DB, bot, cron jobs, and optional health check

require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');

const connectDB = require('./config/database');
const logger = require('./utils/logger');
const { registerUserHandlers } = require('./bot/handlers');
const { registerAdminHandlers } = require('./bot/adminHandlers');
const { registerSuperAdminHandlers } = require('./bot/superAdminHandlers');
const { initCronJobs } = require('./services/cronService');

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// Validate required env vars
const required = ['BOT_TOKEN', 'MONGO_URI', 'PREMIUM_GROUP_ID', 'LOG_CHANNEL_ID', 'SUPER_ADMIN_ID'];
for (const key of required) {
  if (!process.env[key]) {
    logger.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// Global error handler — prevents crashes on unexpected Telegram errors
bot.catch((err, ctx) => {
  logger.error(`Bot error [${ctx.updateType}]: ${err.message}`);
  if (ctx.reply) {
    ctx.reply('❌ An unexpected error occurred. Please try again.').catch(() => {});
  }
});

// Register all handler layers
registerUserHandlers(bot);
registerAdminHandlers(bot);
registerSuperAdminHandlers(bot);

// ── /help ──────────────────────────────────────────────────────────────────
bot.command('help', async (ctx) => {
  const User = require('./models/User');
  const user = await User.findOne({ telegramId: ctx.from.id });
  const role = user?.role || 'user';

  let msg = `🤖 *Bot Commands*\n\n`;
  msg += `*User:*\n/start — Main menu\n/status — Subscription status\n/referral — Your referral link\n/support — Open a support ticket\n/help — This message\n`;

  if (['admin', 'superadmin'].includes(role)) {
    msg += `\n*Admin:*\n/user <id> — User search panel\n/plans — Active plans\n/tickets — Open support tickets\n`;
  }
  if (role === 'superadmin') {
    msg += `\n*Super Admin:*\n/addadmin <id> /removeadmin <id> /admins\n` +
      `/createplan /editplan /deleteplan /pauseplan /listplans\n` +
      `/addoffer /deleteoffer /listoffers\n` +
      `/broadcast — Broadcast to users\n` +
      `/reports — Sales reports\n` +
      `/stats — Growth dashboard\n` +
      `/planstats — Plan performance\n` +
      `/adminlogs — Audit log\n`;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ── Optional Express health check ─────────────────────────────────────────
if (process.env.PORT) {
  const app = express();
  app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
  app.listen(process.env.PORT, () => logger.info(`Health check on port ${process.env.PORT}`));
}

// ── Startup ────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await connectDB();

    // Seed super admin document
    // Seed super admin documents
    const User = require('./models/User');
    const superAdminIds = String(process.env.SUPER_ADMIN_IDS || '')
      .split(',')
      .map(id => parseInt(id.trim()))
      .filter(Boolean);

    for (const id of superAdminIds) {
      await User.findOneAndUpdate(
        { telegramId: id },
        {
          $setOnInsert: {
            telegramId: id,
            name: 'Super Admin',
            role: 'superadmin',
            status: 'active',
          },
        },
        { upsert: true }
      );
    }

    initCronJobs(bot);

    await bot.launch();
    logger.info('🤖 Telegram Subscription Bot v2.0 started!');

    process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
    process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });

  } catch (error) {
    logger.error(`Startup failed: ${error.message}`);
    process.exit(1);
  }
};

start();
