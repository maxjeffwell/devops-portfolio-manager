const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/argocd', require('./routes/argocd'));
app.use('/api/prometheus', require('./routes/prometheus'));
app.use('/api/github', require('./routes/github'));
app.use('/api/helm', require('./routes/helm'));
app.use('/api/applications', require('./routes/applications'));
app.use('/api/metabase', require('./routes/metabase'));

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, () => {
  console.log(`DevOps API running on port ${PORT}`);
});
