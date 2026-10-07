const Todo = require('../models/Todo');

exports.list = async (req, res) => {
  const todos = await Todo.find({ done: false }).sort({ createdAt: -1 });
  res.json(todos);
};

exports.create = async (req, res) => {
  const { title } = req.body;
  const todo = await Todo.create({ title, owner: req.user.id });
  res.status(201).json(todo);
};

exports.remove = async (req, res, next) => {
  try {
    await Todo.findByIdAndDelete(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
};
