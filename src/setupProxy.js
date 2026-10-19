// Lets "npm start" serve the Drive relay too, the same as the live site does (see the api folder)
const { handle } = require('../server/driveRelay');

module.exports = function setupProxy(app) {
  app.use('/api', (req, res, next) => {
    handle(req, res, req.originalUrl)
      .then((handled) => {
        if (!handled) next();
      })
      .catch(next);
  });
};
