// src/models/AdminLog.js
// Audit trail for every admin action in the system

const mongoose = require('mongoose');

const adminLogSchema = new mongoose.Schema({
  adminId: {
    type: Number,
    required: true,
    index: true,
  },
  actionType: {
    type: String,
    required: true,
    enum: [
      'approve_request',
      'reject_request',
      'create_plan',
      'edit_plan',
      'delete_plan',
      'pause_plan',
      'create_offer',
      'delete_offer',
      'add_admin',
      'remove_admin',
      'broadcast',
      'ban_user',
      'unban_user',
      'support_reply',
      'close_ticket',
      'manual_expire',
      'referral_bonus',
    ],
    index: true,
  },
  targetUserId: {
    type: Number,
    default: null,
    index: true,
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true,
  },
}, { timestamps: false });

module.exports = mongoose.model('AdminLog', adminLogSchema);
