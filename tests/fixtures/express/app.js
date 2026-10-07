const express = require('express');
const cors = require('cors');
const todoRoutes = require('./routes/todos');

const app = express();
app.set('view engine', 'ejs');
app.use(cors());
app.use(express.json());
app.use('/api/todos', todoRoutes);

app.get('/', (req, res) => {
  res.render('index', { title: 'Todos' });
});

app.listen(3000);
