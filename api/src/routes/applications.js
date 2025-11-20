const express = require('express');
const router = express.Router();

// Portfolio applications configuration
const applications = [
  {
    id: 'bookmarked',
    name: 'Bookmarked',
    description: 'Bookmark management application',
    namespace: 'default',
    helmChart: 'bookmarked',
    argocdApp: 'bookmarked',
    github: { owner: 'maxjeffwell', repo: 'bookmarks-capstone-api' }
  },
  {
    id: 'code-talk',
    name: 'Code Talk',
    description: 'Code collaboration and review platform',
    namespace: 'default',
    helmChart: 'code-talk',
    argocdApp: 'code-talk',
    github: { owner: 'maxjeffwell', repo: 'code-talk' }
  },
  {
    id: 'educationelly',
    name: 'EducationELLy',
    description: 'Language learning application',
    namespace: 'default',
    helmChart: 'educationelly',
    argocdApp: 'educationelly',
    github: { owner: 'maxjeffwell', repo: 'educationelly' }
  },
  {
    id: 'educationelly-graphql',
    name: 'EducationELLy GraphQL',
    description: 'GraphQL-based education platform',
    namespace: 'default',
    helmChart: 'educationelly-graphql',
    argocdApp: 'educationelly-graphql',
    github: { owner: 'maxjeffwell', repo: 'educationelly-graphql' }
  },
  {
    id: 'firebook',
    name: 'FireBook',
    description: 'Social networking platform',
    namespace: 'default',
    helmChart: 'firebook',
    argocdApp: 'firebook',
    github: { owner: 'maxjeffwell', repo: 'firebook' }
  },
  {
    id: 'intervalai',
    name: 'IntervalAI',
    description: 'Spaced repetition learning with AI',
    namespace: 'default',
    helmChart: 'intervalai',
    argocdApp: 'intervalai',
    github: { owner: 'maxjeffwell', repo: 'spaced-repetition-capstone' }
  }
];

// Get all applications
router.get('/', (req, res) => {
  res.json(applications);
});

// Get specific application
router.get('/:id', (req, res) => {
  const app = applications.find(a => a.id === req.params.id);
  if (!app) {
    return res.status(404).json({ error: 'Application not found' });
  }
  res.json(app);
});

module.exports = router;
