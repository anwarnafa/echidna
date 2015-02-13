'use strict';

console.log('Launching…');

var meta = require('./package.json');
var express = require('express');
var compression = require('compression');
var bodyParser = require('body-parser');
var exec = require('child_process').exec;
var path = require('path');
var Fs = require('fs');
var Promise = require('promise');
var Uuid = require('node-uuid');

var DocumentDownloader = require('./lib/document-downloader');
var History = require('./lib/history');
var JsonHttpService = require('./lib/json-http-service');
var Publisher = require('./lib/publisher');
var SpecberusWrapper = require('./functions.js').SpecberusWrapper;
var ThirdPartyResourcesChecker = require('./lib/third-party-resources-checker');
var TokenChecker = require('./functions.js').TokenChecker;

// Configuration file
require('./config.js');

// Pseudo-constants:
var STATUS_STARTED = 'started';
var STATUS_ERROR = 'error';
var STATUS_SUCCESS = 'success';

var app = express();
var requests = {};
var argTempLocation = process.argv[2] || global.DEFAULT_TEMP_LOCATION;
var argHttpLocation  = process.argv[3] || global.DEFAULT_HTTP_LOCATION;
var port = process.argv[4] || global.DEFAULT_PORT;
var argResultLocation = process.argv[5] || global.DEFAULT_RESULT_LOCATION;

app.use(compression());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(corsHandler);
app.use(express.static('views'));
app.use(express.static('assets'));

if (process.env.NODE_ENV === 'production') {
  app.set('views', __dirname + '/dist/views');
  app.use(express.static(__dirname + '/dist/assets'));
}
else {
  app.set('views', __dirname + '/views');
  app.use(express.static(__dirname + '/assets'));
}

// Index Page
app.get('/', function (request, response) {
  response.sendFile(__dirname + '/views/index.html');
});

// API methods

app.get('/api/version', function (req, res) {
  res.send(meta.version);
});

app.get('/api/version-specberus', function (req, res) {
  res.send(SpecberusWrapper.version);
});

app.get('/api/status', function (req, res) {
  var id = req.query ? req.query.id : null;
  var file = argResultLocation + path.sep + id + '.json';

  if (id) {
    Fs.exists(file, function (exists) {
      if (exists) res.status(200).sendFile(file);
      else if (requests && requests[id]) {
        res.status(200).json(requests[id]);
      }
      else res.status(404).send('No job found with ID “' + id + '”.');
    });
  }
  else res.status(400).send('Missing required parameter “ID”.');
});

app.post('/api/request', function (req, res) {
  var url = req.body ? req.body.url : null;
  var decision = req.body ? req.body.decision : null;
  var token = req.body ? req.body.token : null;
  var id = Uuid.v4();

  if (!url || !decision || !token) {
    res.status(500).send(
      'Missing required parameters “url”, “decision” and/or “token”.'
    );
  }
  else {
    requests[id] = {
      id: id,
      url: url,
      version: meta.version,
      'version-specberus': SpecberusWrapper.version,
      decision: decision,
      jobs: {},
      history: new History(),
      status: STATUS_STARTED
    };

    orchestrate(requests[id], token).then(function () {
      console.log(
        'Spec at ' + url + ' (decision: ' + decision + ') has FINISHED.'
      );
    }, function () {
      console.log(
        'Spec at ' + url + ' (decision: ' + decision + ') has FAILED.'
      );
    });
    res.status(202).send(id);
  }
});

/**
* Add CORS headers to responses if the client is explicitly allowed.
*
* First, this ensures that the testbed page on the test server, listening on a different port, can GET and POST to Echidna.
* Most importantly, this is necessary to attend publication requests from third parties, eg GitHub.
*/

function corsHandler(req, res, next) {
  if (req && req.headers && req.headers.origin) {
    if (global.ALLOWED_CLIENTS.some(function (regex) {
      return regex.test(req.headers.origin);
    })) {
      res.header('Access-Control-Allow-Origin', req.headers.origin);
      res.header('Access-Control-Allow-Methods', 'GET,POST');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
    }
  }
  next();
}

function trInstaller(source, dest) {
  return new Promise(function (resolve, reject) {
    var cmd = global.TR_INSTALL_CMD + ' ' + source + ' ' + dest;
    exec(cmd, function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

function updateTrShortlink(uri) {
  return new Promise(function (resolve, reject) {
    var cmd = global.UPDATE_TR_SHORTLINK_CMD + ' ' + uri;
    exec(cmd, function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

function Job() {
  if (typeof this !== 'object') {
    throw new TypeError('Jobs must be constructed via new');
  }

  this.status = '';
  this.errors = [];
}

function dumpJobResult(dest, result) {
  Fs.writeFile(dest, JSON.stringify(result, null, 2) + '\n', function (err) {
    if (err) return console.error(err);
  });
}

function orchestrate(spec, token) {
  spec.jobs['retrieve-resources'] = new Job();
  spec.jobs['specberus'] = new Job();
  spec.jobs['token-checker'] = new Job();
  spec.jobs['third-party-checker'] = new Job();
  spec.jobs['publish'] = new Job();
  spec.jobs['tr-install'] = new Job();
  spec.jobs['update-tr-shortlink'] = new Job();

  var W3C_PREFIX = 'http://www.w3.org';

  var tempLocation = argTempLocation + path.sep + spec.id + path.sep;
  var resultLocation = argResultLocation + path.sep + spec.id + '.json';
  var httpLocation = argHttpLocation + '/' + spec.id + '/Overview.html';

  function runSpecberus() {
    return SpecberusWrapper.validate(httpLocation);
  }

  function runTokenChecker(report) {
    if (report.errors.isEmpty()) {
      console.log('Specberus SUCCESS');
      return TokenChecker.check(report.metadata.get('latestVersion'), token);
    }
    else {
      console.log('Specberus FAILURE');
      return Promise.reject(new Error('This document has failed Specberus.'));
    }
  }

  function runThirdPartyResourcesChecker(authReport, url) {
    var simpleSource1 = authReport.source.replace(/^https:/i, 'http:');
    var simpleSource2 = authReport.source.replace(/^http:/i, 'https:');
    var matchSource = (
      url.indexOf(simpleSource1) === 0 ||
      url.indexOf(simpleSource2) === 0
    );

    if (authReport.authorized && matchSource) {
      console.log('TokenChecker SUCCESS');
      return ThirdPartyResourcesChecker.check(httpLocation);
    }
    else {
      console.log('TokenChecker FAILURE');
      console.log(authReport);
      return Promise.reject(
        new Error('You are not allowed to publish this document.')
      );
    }
  }

  function runPublisher(extResources, specberusReport) {
    if (extResources.length === 0) {
      console.log('ThirdPartyResourcesChecker SUCCESS');
      return specberusReport.then(function (report) {
        var pubsystemService = new JsonHttpService(
          global.W3C_PUBSYSTEM_URL,
          global.USERNAME,
          global.PASSWORD
        );
        return new Publisher(pubsystemService).publish(report.metadata);
      });
    }
    else {
      console.log('ThirdPartyResourcesChecker FAILURE');
      return Promise.reject(
        new Error('There are external resources in this document.')
      );
    }
  }

  function runTrInstaller(errors, specberusReport) {
    if (errors.isEmpty()) {
      console.log('Publisher SUCCESS');
      return specberusReport.then(function (report) {
        var finalTRpath = report.metadata.get('thisVersion')
          .replace(W3C_PREFIX, '');
        return trInstaller(tempLocation, finalTRpath);
      });
    }
    else {
      console.log('Publisher FAILED');
      return Promise.reject(
        new Error('There was a problem with the publication system.')
      );
    }
  }

  function runShortlink(specberusReport) {
    return specberusReport.then(function (report) {
      return updateTrShortlink(report.metadata.get('thisVersion'));
    });
  }

  function finishTasks(specberusReport) {
    return specberusReport.then(function (report) {
      var cmd =
        global.SENDMAIL + ' SUCCESS ' + global.MAILING_LIST + ' ' +
        report.metadata.get('thisVersion');

      exec(cmd, function (err, stdout, stderr) {
        if (err) console.error(stderr);
      });

      spec.status = STATUS_SUCCESS;
      dumpJobResult(resultLocation, spec);
      return Promise.resolve('finished');
    });
  }

  var specberusReport = DocumentDownloader.fetchAndInstall(
    spec.url,
    tempLocation
  ).then(runSpecberus);

  return specberusReport
    .then(runTokenChecker)
    .then(function (authReport) {
      return runThirdPartyResourcesChecker(authReport, spec.url);
    })
    .then(function (extResources) {
      return runPublisher(extResources, specberusReport);
    })
    .then(function (errors) {
      return runTrInstaller(errors, specberusReport);
    })
    .then(function () {
      return runShortlink(specberusReport);
    })
    .then(function () {
      return finishTasks(specberusReport);
    })
    .catch(function (err) {
      console.log(err.stack);

      spec.status = STATUS_ERROR;
      var cmd =
        global.SENDMAIL + ' ERROR ' + global.MAILING_LIST + ' ' + spec.url +
        ' \'' + JSON.stringify(spec, null, 2) + '\'';
      exec(cmd, function (err, stdout, stderr) {
        if (err) console.error(stderr);
      });
      dumpJobResult(resultLocation, spec);
      return Promise.reject(new Error('Orchestrator has failed.'));
    });

  /*
  spec.jobs['retrieve-resources'].status = 'pending';

    spec.jobs['retrieve-resources'].status = 'ok';
    spec.history = spec.history.add('The file has been retrieved.');
    spec.jobs['specberus'].status = 'pending';

      spec.jobs['specberus'].status = 'ok';
      spec.history = spec.history.add('The document passed specberus.');
      spec.jobs['token-checker'].status = 'pending';

        spec.jobs['token-checker'].status = 'ok';
        spec.history = spec.history.add('You are authorized to publish');
        spec.jobs['third-party-checker'].status = 'pending';

          spec.jobs['third-party-checker'].status = 'ok';
          spec.history = spec.history.add('The document passed the third party checker.');
          spec.jobs['publish'].status = 'pending';

            spec.jobs['publish'].status = 'ok';
            spec.jobs['tr-install'].status = 'pending';

              spec.jobs['tr-install'].status = 'ok';
              spec.jobs['update-tr-shortlink'].status = 'pending';

                spec.jobs['update-tr-shortlink'].status = 'ok';
                spec.history = spec.history.add('The document has been published at <a href="' + report.metadata.get('thisVersion') + '">' + report.metadata.get('thisVersion') + '</a>.');
                spec.status = STATUS_SUCCESS;

                spec.jobs['update-tr-shortlink'].status = 'error';
                spec.jobs['update-tr-shortlink'].errors.push(err.toString());

              spec.jobs['tr-install'].status = 'error';
              spec.jobs['tr-install'].errors.push(err.toString());

            spec.jobs['publish'].status = 'failure';
            spec.jobs['publish'].errors = errors;
            spec.history = spec.history.add('The document could not be published: ' + errors.map(function (error) {
              return error.message;
            }));

            spec.jobs['publish'].status = 'error';
            spec.jobs['publish'].errors.push(err.toString());
            spec.history = spec.history.add('The document could not be published: ' + err.message);

          spec.jobs['token-checker'].status = 'failure';
          spec.jobs['token-checker'].errors.push('Not authorized');
          spec.history = spec.history.add('You are not authorized to publish');

          spec.jobs['token-checker'].status = 'error';
          spec.jobs['token-checker'].errors.push(err.toString());

        spec.history = spec.history.add('The document contains non-authorized resources');
        spec.jobs['third-party-checker'].status = 'failure';
        spec.jobs['third-party-checker'].errors = extResources;

        spec.jobs['third-party-checker'].status = 'error';
        spec.jobs['third-party-checker'].errors.push(err.toString());

      spec.jobs['specberus'].status = 'failure';
      spec.jobs['specberus'].errors = report.errors;
      spec.history = spec.history.add('The document failed specberus.');

      spec.jobs['specberus'].status = 'error';
      spec.jobs['specberus'].errors.push(err.toString());

    spec.history = spec.history.add('The document could not be retrieved.');
    spec.jobs['retrieve-resources'].status = 'error';
    spec.jobs['retrieve-resources'].errors.push(err.toString());

  spec.history = spec.history.add('A system error occurred during the process.');
*/
}

app.listen(process.env.PORT || port).on('error', function (err) {
  if (err) {
    console.error('Error while trying to launch the server: “' + err + '”.');
  }
});

console.log(
  meta.name +
  ' version ' + meta.version +
  ' running on ' + process.platform +
  ' and listening on port ' + port +
  '. The server time is ' + new Date().toLocaleTimeString() + '.'
);
