// src/services/analyticsService.js
// Analytics queries for dashboard stats, plan performance, daily summary

const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Request = require('../models/Request');
const DailySummary = require('../models/DailySummary');
const { startOfToday, endOfToday } = require('../utils/dateUtils');

/**
 * Full growth dashboard stats
 */
const getGrowthStats = async () => {
  const today = startOfToday();
  const todayEnd = endOfToday();

  const [total, active, expired, blocked, newToday, renewalsToday] = await Promise.all([
    User.countDocuments({ role: 'user' }),
    User.countDocuments({ status: 'active' }),
    User.countDocuments({ status: 'expired' }),
    User.countDocuments({ isBlocked: true }),
    User.countDocuments({ createdAt: { $gte: today, $lte: todayEnd } }),
    Subscription.countDocuments({
      isRenewal: true,
      createdAt: { $gte: today, $lte: todayEnd },
    }),
  ]);

  return { total, active, expired, blocked, newToday, renewalsToday };
};

/**
 * Plan performance: active user count per plan
 */
const getPlanPerformance = async () => {
  return Subscription.aggregate([
    {
      $match: {
        status: 'active',
        expiryDate: { $gt: new Date() },
      },
    },
    {
      $group: {
        _id: '$planId',
        planName: { $first: '$planName' },
        durationDays: { $first: '$durationDays' },
        count: { $sum: 1 },
      },
    },
    { $sort: { durationDays: 1 } },
  ]);
};

/**
 * Build today's activity summary (called at end of day by cron)
 */
const buildDailySummary = async () => {
  const today = startOfToday();
  const todayEnd = endOfToday();

  const [newUsers, requestsReceived, approvals, renewals, expiredToday] = await Promise.all([
    User.countDocuments({ createdAt: { $gte: today, $lte: todayEnd } }),
    Request.countDocuments({ requestDate: { $gte: today, $lte: todayEnd } }),
    Request.countDocuments({ status: 'approved', actionDate: { $gte: today, $lte: todayEnd } }),
    Subscription.countDocuments({ isRenewal: true, createdAt: { $gte: today, $lte: todayEnd } }),
    Subscription.countDocuments({
      status: 'expired',
      updatedAt: { $gte: today, $lte: todayEnd },
    }),
  ]);

  // Upsert daily summary
  await DailySummary.findOneAndUpdate(
    { date: today },
    { newUsers, requestsReceived, approvals, renewals, expiredToday },
    { upsert: true, new: true }
  );

  return { newUsers, requestsReceived, approvals, renewals, expiredToday };
};

/**
 * Increment a counter in today's daily summary
 */
const incrementSummaryField = async (field, amount = 1) => {
  const today = startOfToday();
  await DailySummary.findOneAndUpdate(
    { date: today },
    { $inc: { [field]: amount } },
    { upsert: true }
  );
};

module.exports = {
  getGrowthStats,
  getPlanPerformance,
  buildDailySummary,
  incrementSummaryField,
};
