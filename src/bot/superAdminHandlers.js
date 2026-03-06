// src/bot/superAdminHandlers.js
// Super admin: plan/offer/admin management, broadcast, reports, stats, planstats

const User = require('../models/User');
const Plan = require('../models/Plan');
const Subscription = require('../models/Subscription');
const Request = require('../models/Request');
const AdminLog = require('../models/AdminLog');
const mongoose = require('mongoose');
const SellerWithdrawalRequest = require('../models/SellerWithdrawalRequest');
const SellerPayoutLedger = require('../models/SellerPayoutLedger');
const {
  addAdmin, removeAdmin, createPlan, updatePlan, deletePlan,
  getAllPlans, getActivePlans, createOffer, deleteOffer, getActiveOffers
} = require('../services/adminService');
const { getSalesReport, getSalesUserBreakdown, getTodayExpiryList } = require('../services/subscriptionService');
const { getGrowthStats, getCategoryWiseStats, getPlanPerformance } = require('../services/analyticsService');
const {
  getSellerWithdrawalRequests,
  getPendingSellerWithdrawalRequests,
  approveSellerWithdrawal,
  rejectSellerWithdrawal,
} = require('../services/referralService');
const { logToChannel } = require('../services/cronService');
const { safeSend } = require('../utils/telegramUtils');
const { formatDate, startOfToday, endOfToday, startOfWeek, startOfMonth } = require('../utils/dateUtils');
const logger = require('../utils/logger');

// In-memory session for broadcast flow
const sessions = {};

const getSuperAdminIds = () => {
  return String(process.env.SUPER_ADMIN_IDS || process.env.SUPER_ADMIN_ID || '')
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(Boolean);
};

const requireSuperAdmin = async (ctx, next) => {
  const superAdminIds = getSuperAdminIds();
  if (!superAdminIds.includes(ctx.from.id)) {
    return ctx.reply('⛔ Super Admin access required.');
  }
  return next();
};

const registerSuperAdminHandlers = (bot) => {

  const formatUptime = (secondsRaw) => {
    const totalSeconds = Math.max(0, Math.floor(Number(secondsRaw) || 0));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    return `${minutes}m ${seconds}s`;
  };

  const isSuperAdminUser = (telegramId) => {
    const superAdminIds = getSuperAdminIds();
    return superAdminIds.includes(telegramId);
  };

  // ── Admin management ───────────────────────────────────────────────────────
  bot.command('addadmin', requireSuperAdmin, async (ctx) => {
    const id = parseInt(ctx.message.text.split(' ')[1]);
    if (!id) return ctx.reply('Usage: /addadmin <telegramId>');
    try {
      const user = await addAdmin(id);
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'add_admin', targetUserId: id, details: {} });
      await logToChannel(bot, `👑 Admin Added: \`${id}\` (@${user.username || 'N/A'})`);
      await ctx.reply(`✅ *${user.name}* is now an Admin.`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('removeadmin', requireSuperAdmin, async (ctx) => {
    const id = parseInt(ctx.message.text.split(' ')[1]);
    if (!id) return ctx.reply('Usage: /removeadmin <telegramId>');
    try {
      const user = await removeAdmin(id);
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'remove_admin', targetUserId: id, details: {} });
      await ctx.reply(`✅ *${user.name}* is no longer an Admin.`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('admins', requireSuperAdmin, async (ctx) => {
    const admins = await User.find({ role: 'admin' });
    if (!admins.length) return ctx.reply('No admins found.');
    let msg = '👑 *Admin List*\n\n';
    admins.forEach((a, i) => {
      msg += `${i + 1}. ${a.name} — \`${a.telegramId}\`${a.username ? ' (@' + a.username + ')' : ''}\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── Plan management ────────────────────────────────────────────────────────
  // /createplan Name|days|price|category
  bot.command('createplan', requireSuperAdmin, async (ctx) => {
    const text = ctx.message.text.replace('/createplan', '').trim();
    const [name, days, price, rawCategory] = text.split('|').map(s => s.trim());
    if (!name || !days || !rawCategory) return ctx.reply('Usage: `/createplan Name|days|price|category`', { parse_mode: 'Markdown' });
    try {
      const normalizedCategory = String(rawCategory).toLowerCase().replace(/[-\s]/g, '_');
      const allowedCategories = new Set(['movie', 'desi', 'non_desi', 'movie_desi', 'movie_non_desi', 'general']);
      if (!allowedCategories.has(normalizedCategory)) {
        return ctx.reply('❌ Invalid category. Use: movie, desi, non_desi, movie_desi, movie_non_desi');
      }

      const plan = await createPlan({
        name,
        durationDays: parseInt(days),
        price: price ? parseFloat(price) : 0,
        category: normalizedCategory,
      });
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'create_plan', details: { planId: plan._id, name } });
      await ctx.reply(`✅ Plan created: *${plan.name}* (${plan.durationDays} days)\nCategory: *${plan.category}*\nID: \`${plan._id}\``, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  // /editplan id|field|value
  bot.command('editplan', requireSuperAdmin, async (ctx) => {
    const text = ctx.message.text.replace('/editplan', '').trim();
    const [planId, field, value] = text.split('|').map(s => s.trim());
    if (!planId || !field || !value) return ctx.reply('Usage: `/editplan id|field|value`', { parse_mode: 'Markdown' });
    try {
      const updates = { [field]: isNaN(value) ? value : parseFloat(value) };
      const plan = await updatePlan(planId, updates);
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'edit_plan', details: { planId, field, value } });
      await ctx.reply(`✅ Plan *${plan.name}* updated.`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('deleteplan', requireSuperAdmin, async (ctx) => {
    const planId = ctx.message.text.split(' ')[1];
    if (!planId) return ctx.reply('Usage: /deleteplan <planId>');
    try {
      await deletePlan(planId);
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'delete_plan', details: { planId } });
      await ctx.reply('✅ Plan deleted.');
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('pauseplan', requireSuperAdmin, async (ctx) => {
    const planId = ctx.message.text.split(' ')[1];
    if (!planId) return ctx.reply('Usage: /pauseplan <planId>');
    try {
      const plan = await Plan.findByIdAndUpdate(planId, [{ $set: { isActive: { $not: '$isActive' } } }], { new: true });
      await ctx.reply(`✅ Plan *${plan.name}* is now ${plan.isActive ? '✅ Active' : '⏸ Paused'}.`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('resumeplan', requireSuperAdmin, async (ctx) => {
    const planId = ctx.message.text.split(' ')[1];
    if (!planId) return ctx.reply('Usage: /resumeplan <planId>');

    try {
      const plan = await Plan.findById(planId);
      if (!plan) {
        return ctx.reply('❌ Plan not found.');
      }

      if (plan.isActive) {
        return ctx.reply(`ℹ️ Plan *${plan.name}* is already active.`, { parse_mode: 'Markdown' });
      }

      plan.isActive = true;
      await plan.save();

      await AdminLog.create({
        adminId: ctx.from.id,
        actionType: 'edit_plan',
        details: {
          planId: plan._id,
          field: 'isActive',
          value: true,
          command: 'resumeplan',
        },
      });

      await ctx.reply(`✅ Plan *${plan.name}* resumed and set to ✅ Active.`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.command('listplans', requireSuperAdmin, async (ctx) => {
    const plans = await getAllPlans();
    if (!plans.length) return ctx.reply('No plans found.');
    const grouped = {
      movie: [],
      desi: [],
      non_desi: [],
      general: [],
    };

    plans.forEach((plan) => {
      const category = String(plan.category || 'general');
      if (!grouped[category]) grouped[category] = [];
      grouped[category].push(plan);
    });

    let msg = '📋 *All Plans (Category-wise)*\n\n';
    const orderedCategories = ['movie', 'desi', 'non_desi', 'general'];

    for (const category of orderedCategories) {
      const items = grouped[category] || [];
      msg += `*${category.toUpperCase()}*\n`;
      if (!items.length) {
        msg += `No plans\n\n`;
        continue;
      }

      items.forEach((p, i) => {
        msg += `${i + 1}. *${p.name}* — ${p.durationDays} days — ₹${p.price} — ${p.isActive ? '✅' : '⏸'}\n   \`${p._id}\`\n`;
      });
      msg += `\n`;
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── Offer management ───────────────────────────────────────────────────────
  // /addoffer Title|Desc|DD/MM/YYYY|discount%
  bot.command('addoffer', requireSuperAdmin, async (ctx) => {
    const text = ctx.message.text.replace('/addoffer', '').trim();
    const [title, description, dateStr, discount] = text.split('|').map(s => s.trim());
    if (!title || !description || !dateStr) {
      return ctx.reply('Usage: `/addoffer Title|Description|DD/MM/YYYY|discountPercent`', { parse_mode: 'Markdown' });
    }
    try {
      const [d, m, y] = dateStr.split('/');
      const offer = await createOffer({
        title, description,
        validTill: new Date(`${y}-${m}-${d}`),
        discountPercent: discount ? parseInt(discount) : 0,
        createdBy: ctx.from.id,
      });
      await AdminLog.create({ adminId: ctx.from.id, actionType: 'create_offer', details: { offerId: offer._id, title } });
      await ctx.reply(`✅ Offer created: *${offer.title}*`, { parse_mode: 'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('deleteoffer', requireSuperAdmin, async (ctx) => {
    const offerId = ctx.message.text.split(' ')[1];
    if (!offerId) return ctx.reply('Usage: /deleteoffer <offerId>');
    try {
      await deleteOffer(offerId);
      await ctx.reply('✅ Offer deleted.');
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command('listoffers', requireSuperAdmin, async (ctx) => {
    const offers = await getActiveOffers();
    if (!offers.length) return ctx.reply('No active offers.');
    let msg = '🎁 *Active Offers*\n\n';
    offers.forEach((o, i) => {
      msg += `${i + 1}. *${o.title}*\n${o.description}\nValid till: ${formatDate(o.validTill)}\n\`${o._id}\`\n\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── /broadcast ─────────────────────────────────────────────────────────────
  bot.command('broadcast', requireSuperAdmin, async (ctx) => {
    await ctx.reply('📢 *Broadcast — Choose Target:*', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👥 All Users', callback_data: 'bc_all' }, { text: '✅ Active', callback_data: 'bc_active' }],
          [{ text: '❌ Expired', callback_data: 'bc_expired' }, { text: '🆕 New (last 3 days)', callback_data: 'bc_new' }],
        ],
      },
    });
  });

  bot.action(/^bc_(all|active|expired|new)$/, requireSuperAdmin, async (ctx) => {
    await ctx.answerCbQuery();
    sessions[ctx.from.id] = { action: 'broadcast', target: ctx.match[1] };
    await ctx.reply(`📝 Type your broadcast message for *${ctx.match[1]}* users.\nSend /cancel to abort.`, { parse_mode: 'Markdown' });
  });

  // ── /reports ───────────────────────────────────────────────────────────────
  bot.command('reports', requireSuperAdmin, async (ctx) => {
    await ctx.reply('📊 *Reports — Choose Type:*', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📅 Daily Sales', callback_data: 'report_daily' }, { text: '📆 Weekly', callback_data: 'report_weekly' }],
          [{ text: '🗓 Monthly', callback_data: 'report_monthly' }, { text: '📋 Today Expiry', callback_data: 'report_expiry' }],
          [{ text: '✅ Active Users', callback_data: 'report_active' }, { text: '❌ Expired Users', callback_data: 'report_expired' }],
        ],
      },
    });
  });

  bot.action(/^report_(daily|weekly|monthly|expiry|active|expired)$/, requireSuperAdmin, async (ctx) => {
    await ctx.answerCbQuery('Generating...');
    const type = ctx.match[1];
    try {
      let message = '';
      if (type === 'daily' || type === 'weekly' || type === 'monthly') {
        let start = startOfToday();
        let end = endOfToday();
        let title = 'Daily Sales Report';

        if (type === 'weekly') {
          start = startOfWeek();
          end = new Date();
          title = 'Weekly Sales Report';
        } else if (type === 'monthly') {
          start = startOfMonth();
          end = new Date();
          title = 'Monthly Sales Report';
        }

        const userRows = await getSalesUserBreakdown(start, end);
        const chunks = buildCategoryWiseSalesReportMessages(title, userRows, 3500);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: 'Markdown' });
        }
        return;
      } else if (type === 'expiry') {
        const list = await getTodayExpiryList();
        message = `📋 *Today's Expiry List* (${list.length})\n\n`;
        list.forEach((s, i) => { message += `${i + 1}. \`${s.telegramId}\` — ${s.planName}\n`; });
        if (!list.length) message += 'No expirations today.';
      } else if (type === 'active') {
        const c = await Subscription.countDocuments({ status: 'active', expiryDate: { $gt: new Date() } });
        message = `✅ *Active Subscriptions:* ${c}`;
      } else if (type === 'expired') {
        const c = await Subscription.countDocuments({ status: 'expired' });
        message = `❌ *Total Expired:* ${c}`;
      }
      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply('❌ Error generating report.');
      logger.error(`report error: ${err.message}`);
    }
  });

  // ── /report <Nd|Nm> — custom CSV report (e.g. 1d, 7d, 28d, 1m) ─────────
  bot.command('report', requireSuperAdmin, async (ctx) => {
    try {
      const token = (ctx.message.text.split(' ')[1] || '').trim().toLowerCase();
      const parsed = parseReportDuration(token);
      if (!parsed) {
        return ctx.reply('Usage: `/report <Nd|Nm>`\nExamples: `/report 1d`, `/report 7d`, `/report 28d`, `/report 1m`', { parse_mode: 'Markdown' });
      }

      const { value, unit } = parsed;
      const endDate = new Date();
      const startDate = new Date(endDate);
      if (unit === 'd') startDate.setDate(startDate.getDate() - value);
      else startDate.setMonth(startDate.getMonth() - value);

      const [
        requestsReceived,
        approvals,
        rejections,
        subsCreated,
        renewals,
        newUsers,
        activeNow,
        expiredNow,
        blockedNow,
        salesByPlan,
        subscriptionRows,
      ] = await Promise.all([
        Request.countDocuments({ createdAt: { $gte: startDate, $lte: endDate } }),
        Request.countDocuments({ status: 'approved', actionDate: { $gte: startDate, $lte: endDate } }),
        Request.countDocuments({ status: 'rejected', actionDate: { $gte: startDate, $lte: endDate } }),
        Subscription.countDocuments({ createdAt: { $gte: startDate, $lte: endDate } }),
        Subscription.countDocuments({
          createdAt: { $gte: startDate, $lte: endDate },
          isRenewal: true,
        }),
        User.countDocuments({ createdAt: { $gte: startDate, $lte: endDate } }),
        Subscription.countDocuments({ status: 'active', expiryDate: { $gt: endDate } }),
        Subscription.countDocuments({ status: 'expired' }),
        User.countDocuments({ isBlocked: true }),
        getSalesReport(startDate, endDate),
        Subscription.find({
          createdAt: { $gte: startDate, $lte: endDate },
        })
          .select('telegramId planName startDate expiryDate approvedBy status')
          .sort({ createdAt: -1 })
          .lean(),
      ]);

      const label = `${value}${unit}`;
      const generatedAt = new Date();
      const rows = [
        ['Section', 'Metric', 'Value'],
        ['Meta', 'Range', label],
        ['Meta', 'StartDate', startDate.toISOString()],
        ['Meta', 'EndDate', endDate.toISOString()],
        ['Meta', 'GeneratedAt', generatedAt.toISOString()],
        ['Summary', 'RequestsReceived', requestsReceived],
        ['Summary', 'Approvals', approvals],
        ['Summary', 'Rejections', rejections],
        ['Summary', 'SubscriptionsCreated', subsCreated],
        ['Summary', 'Renewals', renewals],
        ['Summary', 'NewUsers', newUsers],
        ['Snapshot', 'ActiveSubscriptionsNow', activeNow],
        ['Snapshot', 'ExpiredSubscriptionsNow', expiredNow],
        ['Snapshot', 'BlockedUsersNow', blockedNow],
      ];

      rows.push([]);
      rows.push(['PlanSales', 'PlanName', 'Count', 'Revenue']);
      if (salesByPlan.length) {
        salesByPlan.forEach((row) => {
          rows.push(['PlanSales', row.planName, row.count, Number(row.totalRevenue || 0).toFixed(2)]);
        });
      } else {
        rows.push(['PlanSales', 'NoData', 0, '0.00']);
      }

      rows.push([]);
      rows.push(['UserSubscriptions', 'UserID', 'Plan', 'StartDate', 'ExpiryDate', 'ApprovedByAdminId', 'Status']);
      if (subscriptionRows.length) {
        subscriptionRows.forEach((sub) => {
          rows.push([
            'UserSubscriptions',
            sub.telegramId,
            sub.planName,
            sub.startDate ? new Date(sub.startDate).toISOString() : '',
            sub.expiryDate ? new Date(sub.expiryDate).toISOString() : '',
            sub.approvedBy ?? '',
            sub.status || '',
          ]);
        });
      } else {
        rows.push(['UserSubscriptions', 'NoData', '', '', '', '', '']);
      }

      const csv = rows.map(toCsvRow).join('\n');
      const fileName = `report_${label}_${generatedAt.toISOString().slice(0, 10)}.csv`;

      await ctx.replyWithDocument(
        {
          source: Buffer.from(csv, 'utf8'),
          filename: fileName,
        },
        {
          caption: `📄 CSV report generated for ${label}`,
        }
      );
    } catch (err) {
      logger.error(`custom report csv error: ${err.message}`);
      await ctx.reply('❌ Failed to generate CSV report.');
    }
  });

  // ── /sellerpayoutscsv [Nd|Nm|all] — seller payouts CSV export ───────────
  bot.command('sellerpayoutscsv', requireSuperAdmin, async (ctx) => {
    try {
      const token = (ctx.message.text.split(' ')[1] || '').trim().toLowerCase();

      let startDate = null;
      let label = 'all';

      if (token && token !== 'all') {
        const parsed = parseReportDuration(token);
        if (!parsed) {
          return ctx.reply('Usage: `/sellerpayoutscsv [Nd|Nm|all]`\nExamples: `/sellerpayoutscsv 7d`, `/sellerpayoutscsv 1m`, `/sellerpayoutscsv all`', { parse_mode: 'Markdown' });
        }

        const { value, unit } = parsed;
        label = `${value}${unit}`;
        startDate = new Date();
        if (unit === 'd') startDate.setDate(startDate.getDate() - value);
        else startDate.setMonth(startDate.getMonth() - value);
      }

      const withdrawalQuery = startDate
        ? { requestedAt: { $gte: startDate } }
        : {};
      const ledgerQuery = startDate
        ? { createdAt: { $gte: startDate } }
        : {};

      const [withdrawals, ledgerRows] = await Promise.all([
        SellerWithdrawalRequest.find(withdrawalQuery)
          .sort({ requestedAt: -1 })
          .lean(),
        SellerPayoutLedger.find(ledgerQuery)
          .sort({ createdAt: -1 })
          .lean(),
      ]);

      const generatedAt = new Date();
      const rows = [
        ['Section', 'Metric', 'Value'],
        ['Meta', 'Range', label],
        ['Meta', 'GeneratedAt', generatedAt.toISOString()],
        ['Summary', 'WithdrawalRows', withdrawals.length],
        ['Summary', 'LedgerRows', ledgerRows.length],
      ];

      rows.push([]);
      rows.push(['Withdrawals', 'RequestId', 'SellerId', 'Status', 'Amount', 'UPI', 'RequestedAt', 'ReviewedAt', 'ReviewedBy', 'Note']);
      if (withdrawals.length) {
        withdrawals.forEach((item) => {
          rows.push([
            'Withdrawals',
            String(item._id),
            item.sellerTelegramId,
            item.status,
            Number(item.amount || 0).toFixed(2),
            item.upiId || '',
            item.requestedAt ? new Date(item.requestedAt).toISOString() : '',
            item.reviewedAt ? new Date(item.reviewedAt).toISOString() : '',
            item.reviewedBy ?? '',
            item.note || '',
          ]);
        });
      } else {
        rows.push(['Withdrawals', 'NoData', '', '', '', '', '', '', '', '']);
      }

      rows.push([]);
      rows.push(['Ledger', 'EntryId', 'SellerId', 'EntryType', 'Source', 'Amount', 'BalanceAfter', 'RelatedUserId', 'RelatedRequestId', 'CreatedAt', 'CreatedBy', 'Note']);
      if (ledgerRows.length) {
        ledgerRows.forEach((entry) => {
          rows.push([
            'Ledger',
            String(entry._id),
            entry.sellerTelegramId,
            entry.entryType,
            entry.source,
            Number(entry.amount || 0).toFixed(2),
            Number(entry.balanceAfter || 0).toFixed(2),
            entry.relatedUserTelegramId ?? '',
            entry.relatedWithdrawalRequestId ? String(entry.relatedWithdrawalRequestId) : '',
            entry.createdAt ? new Date(entry.createdAt).toISOString() : '',
            entry.createdBy ?? '',
            entry.note || '',
          ]);
        });
      } else {
        rows.push(['Ledger', 'NoData', '', '', '', '', '', '', '', '', '', '']);
      }

      const csv = rows.map(toCsvRow).join('\n');
      const fileName = `seller_payouts_${label}_${generatedAt.toISOString().slice(0, 10)}.csv`;

      await ctx.replyWithDocument(
        {
          source: Buffer.from(csv, 'utf8'),
          filename: fileName,
        },
        {
          caption: `📄 Seller payouts CSV generated for ${label}`,
        }
      );
    } catch (err) {
      logger.error(`sellerpayoutscsv error: ${err.message}`);
      await ctx.reply('❌ Failed to generate seller payouts CSV report.');
    }
  });

  // ── /sellerwithdrawalscsv [Nd|Nm|all] [status] — withdrawals-only CSV ──
  bot.command('sellerwithdrawalscsv', requireSuperAdmin, async (ctx) => {
    try {
      const parts = String(ctx.message?.text || '').trim().split(/\s+/);
      const arg1 = String(parts[1] || '').trim().toLowerCase();
      const arg2 = String(parts[2] || '').trim().toLowerCase();

      const allowedStatuses = new Set(['pending', 'approved', 'rejected', 'all']);
      let status = 'all';
      let startDate = null;
      let label = 'all';

      if (arg1) {
        if (allowedStatuses.has(arg1)) {
          status = arg1;
        } else if (arg1 !== 'all') {
          const parsed = parseReportDuration(arg1);
          if (!parsed) {
            return ctx.reply('Usage: `/sellerwithdrawalscsv [Nd|Nm|all] [pending|approved|rejected|all]`\nExamples: `/sellerwithdrawalscsv 7d`, `/sellerwithdrawalscsv 1m pending`, `/sellerwithdrawalscsv all approved`', { parse_mode: 'Markdown' });
          }

          const { value, unit } = parsed;
          label = `${value}${unit}`;
          startDate = new Date();
          if (unit === 'd') startDate.setDate(startDate.getDate() - value);
          else startDate.setMonth(startDate.getMonth() - value);
        }
      }

      if (arg2) {
        if (!allowedStatuses.has(arg2)) {
          return ctx.reply('Usage: `/sellerwithdrawalscsv [Nd|Nm|all] [pending|approved|rejected|all]`\nExamples: `/sellerwithdrawalscsv 7d`, `/sellerwithdrawalscsv 1m pending`, `/sellerwithdrawalscsv all approved`', { parse_mode: 'Markdown' });
        }
        status = arg2;
      }

      const query = {
        ...(startDate ? { requestedAt: { $gte: startDate } } : {}),
        ...(status !== 'all' ? { status } : {}),
      };

      const withdrawals = await SellerWithdrawalRequest.find(query)
        .sort({ requestedAt: -1 })
        .lean();

      const generatedAt = new Date();
      const rows = [
        ['Section', 'Metric', 'Value'],
        ['Meta', 'Range', label],
        ['Meta', 'StatusFilter', status],
        ['Meta', 'GeneratedAt', generatedAt.toISOString()],
        ['Summary', 'WithdrawalRows', withdrawals.length],
      ];

      rows.push([]);
      rows.push(['Withdrawals', 'RequestId', 'SellerId', 'Status', 'Amount', 'UPI', 'RequestedAt', 'ReviewedAt', 'ReviewedBy', 'Note']);
      if (withdrawals.length) {
        withdrawals.forEach((item) => {
          rows.push([
            'Withdrawals',
            String(item._id),
            item.sellerTelegramId,
            item.status,
            Number(item.amount || 0).toFixed(2),
            item.upiId || '',
            item.requestedAt ? new Date(item.requestedAt).toISOString() : '',
            item.reviewedAt ? new Date(item.reviewedAt).toISOString() : '',
            item.reviewedBy ?? '',
            item.note || '',
          ]);
        });
      } else {
        rows.push(['Withdrawals', 'NoData', '', '', '', '', '', '', '', '']);
      }

      const csv = rows.map(toCsvRow).join('\n');
      const fileName = `seller_withdrawals_${label}_${status}_${generatedAt.toISOString().slice(0, 10)}.csv`;

      await ctx.replyWithDocument(
        {
          source: Buffer.from(csv, 'utf8'),
          filename: fileName,
        },
        {
          caption: `📄 Seller withdrawals CSV generated for ${label} (${status})`,
        }
      );
    } catch (err) {
      logger.error(`sellerwithdrawalscsv error: ${err.message}`);
      await ctx.reply('❌ Failed to generate seller withdrawals CSV report.');
    }
  });

  // ── /stats — growth dashboard ──────────────────────────────────────────────
  bot.command('stats', requireSuperAdmin, async (ctx) => {
    try {
      const [s, categoryStats] = await Promise.all([
        getGrowthStats(),
        getCategoryWiseStats(),
      ]);

      const categoryLabel = {
        movie: 'Movie',
        desi: 'Desi',
        non_desi: 'Non-Desi',
        movie_desi: 'Movie + Desi',
        movie_non_desi: 'Movie + Non-Desi',
        general: 'General',
      };

      let categorySection = '\n\n📂 *Category-wise*\n';
      categoryStats.forEach((row) => {
        const label = categoryLabel[row.category] || row.category;
        categorySection +=
          `\n• *${label}*` +
          `\n  Active: *${row.activeSubscriptions}* | Pending: *${row.pendingRequests}*` +
          `\n  Approved Today: *${row.approvalsToday}* | Renewals Today: *${row.renewalsToday}*\n`;
      });

      await ctx.reply(
        `📈 *Growth Dashboard*\n\n` +
        `👥 Total Users: *${s.total}*\n` +
        `✅ Active: *${s.active}*\n` +
        `❌ Expired: *${s.expired}*\n` +
        `🚫 Blocked: *${s.blocked}*\n` +
        `🆕 New Today: *${s.newToday}*\n` +
        `🔄 Renewals Today: *${s.renewalsToday}*` +
        categorySection,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply('❌ Error fetching stats.');
    }
  });

  // ── /categorystats — category-wise CSV snapshot ───────────────────────────
  bot.command('categorystats', requireSuperAdmin, async (ctx) => {
    try {
      const categoryStats = await getCategoryWiseStats();
      const generatedAt = new Date();

      const categoryLabel = {
        movie: 'Movie',
        desi: 'Desi',
        non_desi: 'Non-Desi',
        movie_desi: 'Movie + Desi',
        movie_non_desi: 'Movie + Non-Desi',
        general: 'General',
      };

      const rows = [
        ['Section', 'Category', 'ActiveSubscriptions', 'PendingRequests', 'ApprovalsToday', 'RenewalsToday', 'GeneratedAt'],
      ];

      let totals = {
        activeSubscriptions: 0,
        pendingRequests: 0,
        approvalsToday: 0,
        renewalsToday: 0,
      };

      categoryStats.forEach((row) => {
        rows.push([
          'CategoryStats',
          categoryLabel[row.category] || row.category,
          row.activeSubscriptions,
          row.pendingRequests,
          row.approvalsToday,
          row.renewalsToday,
          generatedAt.toISOString(),
        ]);

        totals.activeSubscriptions += Number(row.activeSubscriptions || 0);
        totals.pendingRequests += Number(row.pendingRequests || 0);
        totals.approvalsToday += Number(row.approvalsToday || 0);
        totals.renewalsToday += Number(row.renewalsToday || 0);
      });

      rows.push([
        'Totals',
        'All Categories',
        totals.activeSubscriptions,
        totals.pendingRequests,
        totals.approvalsToday,
        totals.renewalsToday,
        generatedAt.toISOString(),
      ]);

      const csv = rows.map(toCsvRow).join('\n');
      const fileName = `category_stats_${generatedAt.toISOString().slice(0, 10)}.csv`;

      await ctx.replyWithDocument(
        {
          source: Buffer.from(csv, 'utf8'),
          filename: fileName,
        },
        {
          caption: '📄 Category-wise stats CSV generated.',
        }
      );
    } catch (err) {
      logger.error(`categorystats error: ${err.message}`);
      await ctx.reply('❌ Failed to generate category-wise stats CSV.');
    }
  });

  // ── /planstats — plan performance ─────────────────────────────────────────
  bot.command('planstats', requireSuperAdmin, async (ctx) => {
    try {
      const data = await getPlanPerformance();
      if (!data.length) return ctx.reply('No active subscriptions found.');

      let msg = '📊 *Plan Performance*\n\n';
      data.forEach(row => {
        msg += `📋 *${row.planName}* (${row.durationDays} days): *${row.count}* active users\n`;
      });
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply('❌ Error fetching plan stats.');
    }
  });

  // ── /health — runtime snapshot ────────────────────────────────────────────
  bot.command('health', requireSuperAdmin, async (ctx) => {
    try {
      const dbStateMap = {
        0: 'disconnected',
        1: 'connected',
        2: 'connecting',
        3: 'disconnecting',
      };
      const readyState = mongoose?.connection?.readyState ?? 0;
      const dbState = dbStateMap[readyState] || 'unknown';
      const dbHost = mongoose?.connection?.host || 'N/A';
      const dbName = mongoose?.connection?.name || 'N/A';

      let botUsername = 'N/A';
      let botId = 'N/A';
      try {
        const me = await bot.telegram.getMe();
        botUsername = me?.username ? `@${me.username}` : 'N/A';
        botId = me?.id || 'N/A';
      } catch (_) { }

      const memory = process.memoryUsage();
      const rssBytes = Number(memory.rss || 0);
      const heapUsedBytes = Number(memory.heapUsed || 0);
      const heapTotalBytes = Number(memory.heapTotal || 0);

      const rssMb = (rssBytes / (1024 * 1024)).toFixed(1);
      const heapUsedMb = (heapUsedBytes / (1024 * 1024)).toFixed(1);
      const heapTotalMb = (heapTotalBytes / (1024 * 1024)).toFixed(1);
      const heapUtilization = heapTotalBytes > 0
        ? heapUsedBytes / heapTotalBytes
        : 0;
      const uptimeSeconds = Math.floor(process.uptime());

      const highHeapUtil = heapUtilization >= 0.92;
      const highHeapAbs = heapUsedBytes >= 150 * 1024 * 1024;
      const highRssAbs = rssBytes >= 500 * 1024 * 1024;
      const warmupWindow = uptimeSeconds < 120;
      const memoryPressure = highRssAbs || (highHeapUtil && highHeapAbs);

      const cronTimezone = process.env.CRON_TIMEZONE || 'Asia/Kolkata';
      const reminderSchedules = process.env.REMINDER_CRON_SCHEDULES || '15 9 * * *,0 20 * * *';

      let healthIcon = '🟢';
      let healthLabel = 'HEALTHY';
      let healthReason = 'All core systems operational';

      if (![1, 2, 3].includes(readyState)) {
        healthIcon = '🔴';
        healthLabel = 'CRITICAL';
        healthReason = 'Database disconnected';
      } else if (readyState !== 1 || memoryPressure || botUsername === 'N/A') {
        healthIcon = '🟡';
        healthLabel = 'DEGRADED';
        if (readyState !== 1) healthReason = `Database ${dbState}`;
        else if (memoryPressure) healthReason = highRssAbs ? 'High RSS memory usage' : 'High heap memory pressure';
        else healthReason = 'Bot identity check failed';
      } else if (warmupWindow && highHeapUtil) {
        healthIcon = '🟡';
        healthLabel = 'DEGRADED';
        healthReason = 'Startup warm-up (heap filling; monitor for 2 mins)';
      }

      const msg =
        `🩺 *System Health Snapshot*\n\n` +
        `${healthIcon} *${healthLabel}* — ${healthReason}\n\n` +
        `🤖 Bot: *${botUsername}* (ID: \`${botId}\`)\n` +
        `🟢 Process: PID \`${process.pid}\`\n` +
        `⏱ Uptime: *${formatUptime(process.uptime())}*\n` +
        `🧠 Memory: RSS *${rssMb} MB* | Heap *${heapUsedMb}/${heapTotalMb} MB*\n\n` +
        `🗄 DB State: *${dbState.toUpperCase()}* (code: \`${readyState}\`)\n` +
        `🧭 DB Host: \`${dbHost}\`\n` +
        `📚 DB Name: \`${dbName}\`\n\n` +
        `🕒 Cron TZ: *${cronTimezone}*\n` +
        `⏰ Reminder Schedules: \`${reminderSchedules}\`\n` +
        `🌐 Server Time: ${new Date().toLocaleString('en-IN')}`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`health command error: ${err.message}`);
      await ctx.reply('❌ Unable to fetch health snapshot right now.');
    }
  });

  // ── /sellerstats [limit] — seller summary list ───────────────────────────
  bot.command('sellerstats', requireSuperAdmin, async (ctx) => {
    try {
      const limitArg = parseInt((ctx.message.text.split(' ')[1] || '20').trim(), 10);
      const limit = Number.isFinite(limitArg) ? Math.min(Math.max(limitArg, 1), 100) : 20;

      const sellers = await User.find({ isSeller: true })
        .select('telegramId name username sellerCode sellerStats')
        .sort({ 'sellerStats.availableBalance': -1, 'sellerStats.qualifiedReferrals': -1, createdAt: -1 })
        .limit(limit)
        .lean();

      if (!sellers.length) return ctx.reply('ℹ️ No registered sellers found.');

      let msg = `🛍 *Seller Status List* (Top ${sellers.length})\n\n`;
      sellers.forEach((seller, index) => {
        const stats = seller.sellerStats || {};
        msg += `${index + 1}. Seller ID: \`${seller.telegramId}\`\n`;
        msg += `   Name: ${seller.name || 'N/A'}${seller.username ? ` (@${seller.username})` : ''}\n`;
        msg += `   Seller Code: \`${seller.sellerCode || 'N/A'}\`\n`;
        msg += `   Referrals: *${Number(stats.totalReferrals || 0)}*\n`;
        msg += `   Qualified: *${Number(stats.qualifiedReferrals || 0)}*\n`;
        msg += `   Available Amount: *₹${Number(stats.availableBalance || 0).toFixed(2)}*\n`;
        msg += `   Lifetime Earned: *₹${Number(stats.lifetimeEarnings || 0).toFixed(2)}*\n\n`;
      });

      msg += 'Usage: `/sellerstats` or `/sellerstats 50`';
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`sellerstats error: ${err.message}`);
      await ctx.reply('❌ Unable to fetch seller stats right now.');
    }
  });

  // ── /referralstats [limit] — user referral leaderboard ───────────────────
  bot.command('referralstats', requireSuperAdmin, async (ctx) => {
    try {
      const limitArg = parseInt((ctx.message.text.split(' ')[1] || '20').trim(), 10);
      const limit = Number.isFinite(limitArg) ? Math.min(Math.max(limitArg, 1), 100) : 20;

      const referralCounts = await User.aggregate([
        { $match: { referredBy: { $ne: null } } },
        { $group: { _id: '$referredBy', referralCount: { $sum: 1 } } },
        { $sort: { referralCount: -1, _id: 1 } },
        { $limit: limit },
      ]);

      if (!referralCounts.length) return ctx.reply('ℹ️ No referral data found yet.');

      const referrerIds = referralCounts.map((item) => Number(item._id)).filter(Boolean);
      const referrerUsers = await User.find({ telegramId: { $in: referrerIds } })
        .select('telegramId name username')
        .lean();
      const referrerMap = new Map(referrerUsers.map((item) => [Number(item.telegramId), item]));

      let msg = `🤝 *Referral Leaderboard* (Top ${referralCounts.length})\n\n`;
      referralCounts.forEach((item, index) => {
        const userId = Number(item._id);
        const user = referrerMap.get(userId);
        msg += `${index + 1}. User ID: \`${userId}\`\n`;
        msg += `   Name: ${user?.name || 'N/A'}${user?.username ? ` (@${user.username})` : ''}\n`;
        msg += `   Referrals: *${Number(item.referralCount || 0)}*\n\n`;
      });

      msg += 'Usage: `/referralstats` or `/referralstats 50`';
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`referralstats error: ${err.message}`);
      await ctx.reply('❌ Unable to fetch referral stats right now.');
    }
  });

  // ── Seller withdrawal management ──────────────────────────────────────────
  bot.command('sellerwithdrawals', requireSuperAdmin, async (ctx) => {
    const parts = String(ctx.message?.text || '').trim().split(/\s+/);
    const statusArgRaw = String(parts[1] || 'pending').toLowerCase();
    const allowedStatuses = new Set(['pending', 'approved', 'rejected', 'all']);
    const status = allowedStatuses.has(statusArgRaw) ? statusArgRaw : 'pending';
    const sellerId = parts[2] ? parseInt(parts[2], 10) : null;

    if (parts[2] && !sellerId) {
      return ctx.reply('Usage: /sellerwithdrawals [pending|approved|rejected|all] [sellerTelegramId]');
    }

    const items = status === 'pending' && !sellerId
      ? await getPendingSellerWithdrawalRequests(20)
      : await getSellerWithdrawalRequests({ status, limit: 20, sellerTelegramId: sellerId });

    if (!items.length) return ctx.reply(`✅ No ${status} seller withdrawals found.`);

    let msg = `💸 *Seller Withdrawals — ${status.toUpperCase()}*\n`;
    if (sellerId) msg += `Seller Filter: \`${sellerId}\`\n`;
    msg += '\n';

    items.forEach((item, i) => {
      msg += `${i + 1}. ID: \`${item._id}\`\n`;
      msg += `   Seller: \`${item.sellerTelegramId}\`\n`;
      msg += `   Status: *${String(item.status || '').toUpperCase()}*\n`;
      msg += `   UPI: \`${item.upiId || 'N/A'}\`\n`;
      msg += `   Amount: *₹${Number(item.amount).toFixed(2)}*\n`;
      msg += `   Requested: ${new Date(item.requestedAt).toLocaleString('en-IN')}\n\n`;
    });

    msg += 'Approve: `/approvesellerwd <requestId>`\n';
    msg += 'Reject: `/rejectsellerwd <requestId> | reason`\n\n';
    msg += 'Filter usage: `/sellerwithdrawals pending` or `/sellerwithdrawals approved 123456789`';
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.command('approvesellerwd', requireSuperAdmin, async (ctx) => {
    const requestId = (ctx.message.text.split(' ')[1] || '').trim();
    if (!requestId) return ctx.reply('Usage: /approvesellerwd <requestId>');

    try {
      const request = await approveSellerWithdrawal(requestId, ctx.from.id);
      await safeSend(
        bot,
        request.sellerTelegramId,
        `✅ *Seller Withdrawal Approved*\n\n` +
        `Request ID: \`${request._id}\`\n` +
        `Amount: *₹${Number(request.amount).toFixed(2)}*\n\n` +
        `Payout will be processed shortly.`,
        { parse_mode: 'Markdown' }
      );

      await ctx.reply(`✅ Approved withdrawal \`${request._id}\` for ₹${Number(request.amount).toFixed(2)}.`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.command('rejectsellerwd', requireSuperAdmin, async (ctx) => {
    const raw = ctx.message.text.replace('/rejectsellerwd', '').trim();
    const [requestIdPart, ...rest] = raw.split('|');
    const requestId = (requestIdPart || '').trim();
    const reason = rest.join('|').trim();

    if (!requestId) return ctx.reply('Usage: /rejectsellerwd <requestId> | reason');

    try {
      const request = await rejectSellerWithdrawal(requestId, ctx.from.id, reason);
      await safeSend(
        bot,
        request.sellerTelegramId,
        `❌ *Seller Withdrawal Rejected*\n\n` +
        `Request ID: \`${request._id}\`\n` +
        `Amount: *₹${Number(request.amount).toFixed(2)}*\n` +
        `${request.note ? `Reason: ${request.note}\n` : ''}`,
        { parse_mode: 'Markdown' }
      );

      await ctx.reply(`✅ Rejected withdrawal \`${request._id}\`.`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── /revokeseller <telegramId> — revoke seller program access ───────────
  bot.command('revokeseller', requireSuperAdmin, async (ctx) => {
    const targetId = parseInt((ctx.message.text.split(' ')[1] || '').trim(), 10);
    if (!targetId) return ctx.reply('Usage: /revokeseller <telegramId>');

    try {
      const user = await User.findOne({ telegramId: targetId });
      if (!user) return ctx.reply(`❌ User \`${targetId}\` not found.`, { parse_mode: 'Markdown' });

      if (!user.isSeller && !user.sellerCode) {
        return ctx.reply(`ℹ️ User \`${targetId}\` is not an active seller.`, { parse_mode: 'Markdown' });
      }

      const previousSellerCode = user.sellerCode || null;

      const pendingRequests = await SellerWithdrawalRequest.find({
        sellerTelegramId: targetId,
        status: 'pending',
      }).select('_id').lean();

      const pendingRequestIds = pendingRequests.map((request) => String(request._id));
      const rejectedPendingCount = pendingRequestIds.length;

      if (rejectedPendingCount > 0) {
        await SellerWithdrawalRequest.updateMany(
          { _id: { $in: pendingRequestIds } },
          {
            $set: {
              status: 'rejected',
              reviewedAt: new Date(),
              reviewedBy: ctx.from.id,
              note: 'Auto-rejected due to seller revocation',
            },
          }
        );
      }

      await User.findByIdAndUpdate(user._id, {
        $set: { isSeller: false },
        $unset: {
          sellerCode: '',
          'meta.sellerRegisteredAt': '',
        },
      });

      await AdminLog.create({
        adminId: ctx.from.id,
        actionType: 'revoke_seller',
        targetUserId: targetId,
        details: {
          previousSellerCode,
          rejectedPendingCount,
          rejectedPendingRequestIds: pendingRequestIds,
        },
      });

      await safeSend(
        bot,
        targetId,
        `⛔ *Seller Program Revoked*\n\n` +
        `Your seller access has been revoked by admin.\n` +
        (rejectedPendingCount > 0
          ? `Pending withdrawals rejected: *${rejectedPendingCount}*.\n`
          : '') +
        `If this is unexpected, contact support.`,
        { parse_mode: 'Markdown' }
      );

      await logToChannel(
        bot,
        `⛔ *Seller Revoked*\n` +
        `User: \`${targetId}\`\n` +
        `By: ${ctx.from.username ? '@' + ctx.from.username : ctx.from.id}` +
        (rejectedPendingCount > 0 ? `\nPending WD Rejected: ${rejectedPendingCount}` : '') +
        `${previousSellerCode ? `\nPrevious Code: \`${previousSellerCode}\`` : ''}`
      );

      await ctx.reply(
        `✅ Seller revoked for \`${targetId}\`.` +
        (rejectedPendingCount > 0 ? `\n❌ Rejected pending withdrawals: *${rejectedPendingCount}*` : ''),
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error(`revokeseller error: ${err.message}`);
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.action(/^swd_(approve|reject)_(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const requestId = ctx.match[2];

    if (!isSuperAdminUser(ctx.from.id)) {
      return ctx.answerCbQuery('⛔ Super Admin only', { show_alert: true });
    }

    await ctx.answerCbQuery(action === 'approve' ? 'Approving...' : 'Rejecting...');

    try {
      let request;
      if (action === 'approve') {
        request = await approveSellerWithdrawal(requestId, ctx.from.id);
        await safeSend(
          bot,
          request.sellerTelegramId,
          `✅ *Seller Withdrawal Approved*\n\n` +
          `Request ID: \`${request._id}\`\n` +
          `Amount: *₹${Number(request.amount).toFixed(2)}*\n\n` +
          `Payout will be processed shortly.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        request = await rejectSellerWithdrawal(requestId, ctx.from.id, 'Rejected from inline action');
        await safeSend(
          bot,
          request.sellerTelegramId,
          `❌ *Seller Withdrawal Rejected*\n\n` +
          `Request ID: \`${request._id}\`\n` +
          `Amount: *₹${Number(request.amount).toFixed(2)}*\n` +
          `Reason: ${request.note}`,
          { parse_mode: 'Markdown' }
        );
      }

      try {
        await ctx.editMessageText(
          `${ctx.callbackQuery.message.text}\n\n` +
          `${action === 'approve' ? '✅ *APPROVED*' : '❌ *REJECTED*'} by ${ctx.from.username ? '@' + ctx.from.username : ctx.from.id}`,
          { parse_mode: 'Markdown' }
        );
      } catch (_) { }
    } catch (err) {
      await ctx.answerCbQuery(`❌ ${err.message}`, { show_alert: true });
    }
  });

  // ── /adminlogs — recent admin activity ────────────────────────────────────
  bot.command('adminlogs', requireSuperAdmin, async (ctx) => {
    const logs = await AdminLog.find({}).sort({ timestamp: -1 }).limit(15);
    if (!logs.length) return ctx.reply('No admin logs found.');
    let msg = '📋 *Recent Admin Actions*\n\n';
    logs.forEach(l => {
      msg += `• \`${l.actionType}\` by \`${l.adminId}\``;
      if (l.targetUserId) msg += ` → \`${l.targetUserId}\``;
      msg += `\n  ${new Date(l.timestamp).toLocaleString('en-GB')}\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ── /bcancel ───────────────────────────────────────────────────────────────
  bot.command('bcancel', requireSuperAdmin, async (ctx) => {
    if (sessions[ctx.from.id]) {
      delete sessions[ctx.from.id];
      await ctx.reply('✅ Cancelled.');
    }
  });

  // ── Text handler: broadcast message capture ───────────────────────────────
  bot.on('text', async (ctx, next) => {
    const session = sessions[ctx.from.id];
    if (!session || session.action !== 'broadcast') return next();
    delete sessions[ctx.from.id];

    const { target } = session;
    const message = ctx.message.text;

    let filter = { role: 'user', isBlocked: false };
    if (target === 'active') filter.status = 'active';
    else if (target === 'expired') filter.status = 'expired';
    else if (target === 'new') {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      filter.createdAt = { $gte: threeDaysAgo };
    }

    const users = await User.find(filter);
    await ctx.reply(`📤 Sending to *${users.length}* users...`, { parse_mode: 'Markdown' });

    let sent = 0, failed = 0;
    for (const user of users) {
      const ok = await safeSend(bot, user.telegramId, message);
      ok ? sent++ : failed++;
      await new Promise(r => setTimeout(r, 50)); // rate limit throttle
    }

    const summary = `📢 *Broadcast Complete*\n✅ Sent: ${sent}\n❌ Failed: ${failed}\nTarget: ${target}`;
    await ctx.reply(summary, { parse_mode: 'Markdown' });
    await logToChannel(bot, summary);

    await AdminLog.create({
      adminId: ctx.from.id,
      actionType: 'broadcast',
      details: { target, sent, failed, message: message.substring(0, 100) },
    });
  });
};

const formatSalesReport = (title, data) => {
  if (!data.length) return `${title}\n\nNo data found.`;
  let msg = `*${title}*\n\n`;
  let totalSubs = 0, totalRevenue = 0;
  data.forEach(r => {
    msg += `📋 *${r.planName}*: ${r.count} subs — ₹${r.totalRevenue.toFixed(2)}\n`;
    totalSubs += r.count;
    totalRevenue += r.totalRevenue;
  });
  msg += `\n📊 Total: ${totalSubs} — ₹${totalRevenue.toFixed(2)}`;
  return msg;
};

const buildMarkdownChunks = (header, lines, maxLength = 3500) => {
  const chunks = [];
  let current = header;

  lines.forEach((line) => {
    const next = `${current}${line}\n`;
    if (next.length > maxLength && current !== header) {
      chunks.push(current.trimEnd());
      current = `${header}${line}\n`;
    } else {
      current = next;
    }
  });

  if (current.trim()) {
    chunks.push(current.trimEnd());
  }
  return chunks;
};

const buildCategoryWiseSalesReportMessages = (title, rows, maxLength = 3500) => {
  const categoryOrder = ['movie', 'desi', 'non_desi', 'movie_desi', 'movie_non_desi', 'general'];
  const categoryLabel = {
    movie: 'Movie',
    desi: 'Desi',
    non_desi: 'Non-Desi',
    movie_desi: 'Movie + Desi',
    movie_non_desi: 'Movie + Non-Desi',
    general: 'General',
  };

  const grouped = {};
  categoryOrder.forEach((key) => {
    grouped[key] = [];
  });

  rows.forEach((row) => {
    const key = categoryOrder.includes(row.planCategory) ? row.planCategory : 'general';
    grouped[key].push(row);
  });

  const sections = [`📊 *${title}*`];
  let grandCount = 0;
  let grandRevenue = 0;
  const categorySummaries = [];

  categoryOrder.forEach((key) => {
    const items = grouped[key] || [];
    let categoryRevenue = 0;
    let section = `\n*${categoryLabel[key]} List*\n`;

    if (!items.length) {
      section += '_No sales_\n';
    } else {
      items.forEach((row, index) => {
        const price = Number(row.planPrice || 0);
        categoryRevenue += price;
        const safePlanName = escapeTelegramMarkdown(String(row.planName || 'Plan'));
        section += `${index + 1}. \`${row.telegramId}\` | ${safePlanName} | ₹${price.toFixed(2)}\n`;
      });
    }

    section += `Subtotal: *${items.length}* sales | *₹${categoryRevenue.toFixed(2)}*\n`;
    sections.push(section.trimEnd());

    grandCount += items.length;
    grandRevenue += categoryRevenue;
    categorySummaries.push({ key, count: items.length, revenue: categoryRevenue });
  });

  let summarySection = '\n*Summary*\n';
  categorySummaries.forEach((row) => {
    summarySection += `${categoryLabel[row.key]}: *${row.count}* sales | *₹${row.revenue.toFixed(2)}*\n`;
  });
  summarySection += `\nTotal Sales: *${grandCount}*\n`;
  summarySection += `Total Revenue: *₹${grandRevenue.toFixed(2)}*`;
  sections.push(summarySection.trimEnd());

  return chunkMarkdownSections(sections, maxLength);
};

const chunkMarkdownSections = (sections, maxLength = 3500) => {
  const chunks = [];
  let current = '';

  sections.forEach((section) => {
    const block = `${section}\n\n`;
    if ((current + block).length > maxLength && current.length > 0) {
      chunks.push(current.trimEnd());
      current = block;
    } else {
      current += block;
    }
  });

  if (current.trim()) {
    chunks.push(current.trimEnd());
  }

  return chunks;
};

const escapeTelegramMarkdown = (value) => {
  return String(value || '').replace(/([_*\[\]()`])/g, '\\$1');
};

const parseReportDuration = (token) => {
  const match = String(token || '').match(/^(\d+)([dm])$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (!value || value <= 0) return null;
  if (unit === 'd' && value > 365) return null;
  if (unit === 'm' && value > 24) return null;
  return { value, unit };
};

const toCsvCell = (value) => {
  const raw = value === null || typeof value === 'undefined' ? '' : String(value);
  if (/[",\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
};

const toCsvRow = (columns) => {
  return columns.map(toCsvCell).join(',');
};

module.exports = { registerSuperAdminHandlers };
