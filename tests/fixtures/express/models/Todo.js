const mongoose = require('mongoose');

const todoSchema = new mongoose.Schema({
  title: { type: String, required: true },
  done: { type: Boolean, default: false },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});

module.exports = mongoose.model('Todo', todoSchema);
