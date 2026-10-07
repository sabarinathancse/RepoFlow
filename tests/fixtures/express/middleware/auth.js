const jwt = require('jsonwebtoken');

exports.requireAuth = (req, res, next) => {
  try {
    req.user = jwt.verify(req.headers.authorization, process.env.JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'unauthorized' });
  }
};
