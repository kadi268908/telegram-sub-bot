// src/models/DmWordFilter.js
// DM word filters added by admins/superadmins to gate fallback reply behavior

const mongoose = require('mongoose');

const dmWordFilterSchema = new mongoose.Schema({
    phrase: {
        type: String,
        required: true,
        trim: true,
        unique: true,
        index: true,
    },
    normalizedPhrase: {
        type: String,
        required: true,
        trim: true,
        unique: true,
        index: true,
    },
    createdBy: {
        type: Number,
        required: true,
        index: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

module.exports = mongoose.model('DmWordFilter', dmWordFilterSchema);
