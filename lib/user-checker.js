/**
 * @file When using CURL with tar file, check if the user can publish the document by checking if he's participating in the WG
 */
'use strict';

var List = require('immutable').List;
var Promise = require('promise');

/**
 * @exports lib/user-checker
 */

var UserChecker = {};

/**
 * @returns {Promise.<List.<String>>}
 */

UserChecker.check = function (user, delivererIDs) {
  return new Promise(function (resolve) {
    var errors = new List();
    var groups = new Set(user.memberOf.map(function (group) {
      var matches = group.match(/^cn=(\d*),ou=groups,dc=w3,dc=org$/i);

      if (matches) return Number(matches[1]);
    }));
    var delivererSet = new Set(delivererIDs);

    if (![...groups].some(x => delivererSet.has(x))) {
      errors = errors.push('You are not participating in the following groups: ' +
          delivererIDs.join(', '));
    }
    resolve(errors);
  });
};

module.exports = UserChecker;
