const express = require('express');
const router = express.Router();
const todoController = require('../controllers/todoController');
const { requireAuth } = require('../middleware/auth');

router.get('/', todoController.list);
router.post('/', requireAuth, todoController.create);
router.delete('/:id', requireAuth, todoController.remove);

module.exports = router;
