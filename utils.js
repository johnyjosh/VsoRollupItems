"use strict";
const request = require("request-promise");
const q = require('q');
const _ = require('lodash');

function encodePat(pat) {
  const b = Buffer.from(':' + pat);
  return b.toString('base64');
}

class VsoConfig {
  constructor(vstsBaseUri, vstsProject, vsoToken) {
    this.vstsBaseUri = vstsBaseUri;
    this.vstsProject = vstsProject;
    this.vsoToken = encodePat(vsoToken);
  }
}

const MaxIdsInSingleCall = 200;

module.exports = {
  
  VsoConfig: VsoConfig,
  
  // vsoConfig: vso configuration details
  // method: GET, POST, PATCH, etc
  // uri: The HTTP endpoint
  // body: Optional body parameter
  vstsApi: function(vsoConfig, method, uri, body) {
    const options = {
        method: method,
        headers: { 'cache-control': 'no-cache', 'authorization': `Basic ${vsoConfig.vsoToken}` },
        uri: uri,
        qs: { 'api-version': '1.0' },
        body: body,
        json: method == 'PATCH' ? false : true
    };

    return request(options)
    .catch(error => {
        console.log(`vstsApi error: method:${method}, uri:${uri}, body:${body}`);
        throw error;
    });
  },

  // Expects an array of work item IDs and the set of vso fields to query.
  // The set of fields needs to be comma separated and without blanks.
  // Returns a hashmap where key is the item ID and value has a fields structure
  // with all the roll up fields as well as work item type.
  getWorkItemFields: function(vsoConfig, ids, fieldNames) {
    var deferred = q.defer();
    const chunkedIds = _.chunk(ids, MaxIdsInSingleCall);
    var isError = false;

    // We will do batched queries using a VSO REST API that can take up to 200
    // work item IDs in a single call.        
    // Collate all the results into a single "results" structure.
    var results = {};

    // We will need an array of promises to capture results of each REST API call
    var resultPromises = [];

    _.each(chunkedIds, idsCapped => {
        var deferred = q.defer();
        resultPromises.push(deferred.promise);
        const idsCappedJoined = _.join(idsCapped);
        this.vstsApi(vsoConfig, 'GET', `${vsoConfig.vstsBaseUri}/_apis/wit/workitems?ids=${idsCappedJoined}&fields=${fieldNames}`)
        .then(response => {
            // The response is {count, value} where value is the array of VSO items.
            _.each(response.value, workItemFields => {
                // TODO: Check if this is async or sync, we can't resolve
                // the promise below until this is done.
                results[workItemFields.id] = {
                    fields: workItemFields.fields,
                    state: {  // Will be used later
                        rollupInfo: {},
                        isProcessed: false,
                        isUpdateRequired: false
                    }
                }
            });
            deferred.resolve();
        })
        .catch(error => {
            deferred.reject();
        });
    });
    
    q.all(resultPromises)
    .then(x => deferred.resolve(results))
    .catch(error => deferred.reject(error));

    return deferred.promise;
  },

  // ADO requires a list to be in the form of ('a','b','c').
  // This routine converts a JSON array of strings [a,b,c] into the above format.
  getAdoListFromArray: function(inputArray) {
    if (!inputArray || inputArray.length < 1) {
      return null;
    }
    return "(" + inputArray.map(x => `'${x}'`).join(",") + ")"
  }
}