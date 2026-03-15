const express = require('express');
const app = express();

const loginRoutes = require('./routes/loginRoutes');
const homeRoutes = require('./routes/homeRoutes');

app.use(express.static('public'));

app.use('/', loginRoutes);
app.use('/login', loginRoutes);
app.use('/home', homeRoutes);

app.listen(3000, () => {
    console.log('Server is running on port 3000');
})