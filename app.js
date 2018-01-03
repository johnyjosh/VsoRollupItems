/*
 * Program to automatically roll-up cost fields for a given set of VSO work items.
 * This will recompute from the leaf nodes up, so any saved costs in the parent work items
 * is completely ignored and will get overwritten.
 */
"use strict";
const request = require("request-promise");
const q = require('q');
const _ = require('lodash');
const cmdargs = require('command-line-args'); // https://www.npmjs.com/package/command-line-args

const encodedPat = encodePat('{PUT IN YOUR OWN PRIVATE ACCESS TOKEN}');

const queryId = 'ebdee26e-0fa5-4330-8df4-db07b131ab38';
const vstsConstants = {
  baseVstsUri: 'https://domoreexp.visualstudio.com/defaultcollection',
  project: 'MSTeams',
  fieldsToRollup: ['Microsoft.VSTS.Scheduling.RemainingWork', 'Microsoft.VSTS.Scheduling.OriginalEstimate'],
  maxIdsInSingleCall: 200,
  batchSize: 50, // Updates are made in batches. Just picking a number for now, will find more precise limits later
  maxUpdates: 100 // Just a safety net in case there is a logical bug in the code that results in too many work items being updated
};

const options = [
    { name: 'forcecap', type: Number },
    { name: 'showupdatesonly', type: Boolean },
    { name: 'safe', alias: 'n', type: Boolean}
];
const args = cmdargs(options);

if (args.forcecap) {
    console.log(`Capping updates to max of ${args.forcecap}.`);
}
if (args.safe) {
    console.log(`Safe mode enabled, updates will be computed, but not persisted to VSO.`);
}

if (args.showupdatesonly) {
    console.log(`Entries that are computed and then skipped will not be shown in the console output.`);
}

// 1. Execute the query to retrieve the hierarchy of work items in the given area path.
// Note that the query is from WorkItemLinks rather than from WorkItems.
// The other option would have been to start from all the top level items (Epics)
// and then query for children recursively and do the roll ups per top level item.
//
// If we want to execute a pre-canned query, then the following GET will allow for that:
// vstsApi('GET', `${vstsConstants.baseVstsUri}/${vstsConstants.project}/_apis/wit/wiql/${queryId}`)
//
vstsApi('POST', `${vstsConstants.baseVstsUri}/${vstsConstants.project}/_apis/wit/wiql`,
    {
        query: "SELECT [System.Id] \
            FROM WorkItemLinks \
            WHERE [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward' and \
                Source.[System.WorkItemType] in ('Epic', 'Feature') and \
                Source.[System.AreaPath] under 'MSTeams\\Web Client\\Meetings\\Broadcast' and \
                Target.[System.AreaPath] under 'MSTeams\\Web Client\\Meetings\\Broadcast' and \
                Target.[System.AreaPath] not under 'MSTeams\\Web Client\\Meetings\\Broadcast\\Design' and \
                Target.[System.WorkItemType] in ('Feature', 'Requirement', 'Task') \
                MODE (Recursive)"
    })
.then(queryResults => {
    // 2. Restructure the hierarchy info into a more convenient format that brings all
    //    the child items into one array.
    var workItemsHierarchy = {};
    _.each(queryResults.workItemRelations, elm => {
        if (elm.rel == 'System.LinkTypes.Hierarchy-Forward') {
            // Hierarchy-Forward represents the parent-child relationship with source
            // being the parent and target being the children. Note that work items
            // with no no parents have a null source but it is safe to access source.id
            // because we of the elm.rel == Hierarchy-Forward check.
            workItemsHierarchy[elm.source.id] = workItemsHierarchy[elm.source.id] || [];
            workItemsHierarchy[elm.source.id].push(elm.target.id);
        }
    });

    // 3. Query for additional fields for each of the work items
    return getWorkItemFields(_.map(queryResults.workItemRelations, x => x.target.id))
    .then(workItemsWithFields => {
        return {
            workItemsHierarchy: workItemsHierarchy,
            workItemsWithFields: workItemsWithFields
        };
    })
    .catch(error => {
        console.log("Error from getWorkItemFields()");
        throw error;
    })
})
.then(vsoItems => {
    rollupCosts(vsoItems);
    return vsoItems;
})
.then((vsoItems) => {
    // Print out the update plan for reference
    // TODO: Make this optional based on parameter.
    var shortenedFieldNames = _.map(vstsConstants.fieldsToRollup, fieldName => _.replace(fieldName, "Microsoft.VSTS.Scheduling.", ""));
    console.log("id\tTitle\tworkItemType\tState\tisSelectedForUpdate\t" + _.join(shortenedFieldNames, "(Old)\t") + "(Old)\t" + _.join(shortenedFieldNames, "(New)\t") + "(New)");
    _.each(vsoItems.workItemsWithFields, (workItemFields, id) => {
        var isSelected = selectionCriteria(vsoItems, id);
        var fieldValuesOld = "", fieldvaluesNew = "";
        _.each(vstsConstants.fieldsToRollup, fieldName => {
            fieldValuesOld += workItemFields.fields[fieldName] + "\t";
            fieldvaluesNew += workItemFields.state.rollupInfo[fieldName] + "\t";
        });
        if (!args.showupdatesonly || isSelected) {
            console.log(`${id}\t"${workItemFields.fields['System.Title']}"\t${workItemFields.fields['System.WorkItemType']}\t${workItemFields.fields['System.State']}\t${isSelected}\t` + fieldValuesOld + fieldvaluesNew);
        }
    });
    return vsoItems; // Just pass it down the chain
})
.then((vsoItems) => {
    if (args.safe) {
        console.log("Skipping update because safe mode is enabled.");
    } else {
        console.log("Writing updated costs into VSO.");
        return updateCosts(vsoItems);
    }
})
.catch(error => {
    console.log("Encountered an error: " + error);
})
.finally(() => {
    console.log("Program is done.");
});

// If a valid rollup value could be computed (for example during rollup we don't even visit orphaned items),
// and if it is not the same as what is already in VSO, only then do we want to update.
function selectionCriteria(vsoItems, id) {
    var workItemFields = vsoItems.workItemsWithFields[id];
    var netSum = 0;
    var isUpdatedValue = _.some(vstsConstants.fieldsToRollup, fieldName => {
        var rollupValue = workItemFields.state.rollupInfo[fieldName];
        var currentValue = workItemFields.fields[fieldName];
        netSum += rollupValue + currentValue;
        return (rollupValue != undefined && currentValue != rollupValue);
    });

    // This catches the case where old values are undefined and new values are zeroes, but in effect there is no net update
    return netSum > 0 && isUpdatedValue;
}

// Write the computed costs back to VSO, use batched updates for reducing round trips
function updateCosts(vsoItems) {
    var ids = _.map(vsoItems.workItemsWithFields, (v,id) => id);

    var filteredIds = _.filter(ids, (id) => selectionCriteria(vsoItems, id));
    var cappedIds = _.take(filteredIds, args.forcecap || vstsConstants.maxUpdates);
    if (filteredIds.length != cappedIds.length) {
        console.error(`Warning: ${filteredIds.length} updates computed, capping to ${cappedIds.length}`);
    }

    var chunkedIds = _.chunk(cappedIds, vstsConstants.batchSize);

    var deferred = q.defer();
    var resultPromises = [];

    _.each(chunkedIds, idsToUpdate => {
        var patchRequests = _.map(idsToUpdate, id => {
            var patchOp = {
                "method": "PATCH",
                "uri" : `/_apis/wit/workitems/${id}?api-version=1.0`,
                "headers": {
                    "Content-Type": "application/json-patch+json"
                }
            }

            // list of operations (one per rollup field)
            patchOp.body = _.map(vstsConstants.fieldsToRollup, fieldName => {
                return {
                    "op" : "replace",
                    "path" : `/fields/${fieldName}`,
                    "value" : `${vsoItems.workItemsWithFields[id].state.rollupInfo[fieldName]}` // Value has to be a string, otherwise it errors out
                }
            });

            return patchOp;
        });
  
        var deferred = q.defer();
        resultPromises.push(deferred.promise);
        vstsApi('POST', `${vstsConstants.baseVstsUri}/_apis/wit/$batch`, patchRequests)
        .then(x => deferred.resolve())
        .catch(error => deferred.reject(error));
    });

    q.all(resultPromises)
    .then(x => deferred.resolve())
    .catch(error => deferred.reject(error));

    return deferred.promise;
}

// Expects an object with two fields:
// workItemsHierarchy and workItemsWithFields
// Both are indexed by work item ID.
// workItemsHierarchy[id] is an array of direct chid work item IDs (not recursive).
// workItemsWithFields[id].fields has the cost info from VSO.
// workItemsWithFields[id].state will be used to maintain state on whether a given
// item has been rolled up yet.
function rollupCosts(vsoItems) {
    _.each(vsoItems.workItemsHierarchy, (childIds, itemId) => rollupCostsForItem(vsoItems, itemId));
}

function rollupCostsForItem(vsoItems, itemId) {
    var workItemFields = vsoItems.workItemsWithFields[itemId];
    if (workItemFields.state['isProcessed']) {
        // If roll up is already done for this item, then this is a no-op call.
        return;
    }

    var hierarchyInfo = vsoItems.workItemsHierarchy[itemId];
    if (hierarchyInfo == undefined) {
        // For leaf nodes, we just copy the item's costs into the state.rollupInfo structure.
        _.each(vstsConstants.fieldsToRollup, fieldName => workItemFields.state.rollupInfo[fieldName] = workItemFields.fields[fieldName] || 0);
    } else {
        _.each(vstsConstants.fieldsToRollup, fieldName => workItemFields.state.rollupInfo[fieldName] = 0);

        // Go through each child, ensure that the child is processed, then add up that child's
        // cost info into the aggregate. We ensure that even leaf node item costs are copied into
        // the "rollupInfo" structure.
        _.each(hierarchyInfo, childId => {
            rollupCostsForItem(vsoItems, childId);
            _.each(vstsConstants.fieldsToRollup, fieldName => workItemFields.state.rollupInfo[fieldName] += vsoItems.workItemsWithFields[childId].state.rollupInfo[fieldName]);
        });

    }

    workItemFields.state['isProcessed'] = true;
}

// Expects an array of work item IDs.
// Returns a hashmap where key is the item ID and value has a fields structure
// with all the roll up fields as well as work item type.
function getWorkItemFields(ids) {
    var deferred = q.defer();
    var chunkedIds = _.chunk(ids, vstsConstants.maxIdsInSingleCall);
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
        var idsCappedJoined = _.join(idsCapped);
        var fields = 'System.Id,System.Title,System.WorkItemType,System.State,' + _.join(vstsConstants.fieldsToRollup);
        vstsApi('GET', `${vstsConstants.baseVstsUri}/_apis/wit/workitems?ids=${idsCappedJoined}&fields=${fields}`)
        .then(response => {
            // The response is {count, value} where value is the array of VSO items.
            _.each(response.value, workItemFields => {
                // TODO: Check if this is async or sync, we can't resolve
                // the promise below until this is done.
                results[workItemFields.id] = {
                    fields: workItemFields.fields,
                    state: {  // Will be used later
                        rollupInfo: {},
                        isProcessed: false
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
}

// method: GET, POST, PATCH, etc
// uri: The HTTP endpoint
// body: Optional body parameter
function vstsApi(method, uri, body) {
    var options = {
        method: method,
        headers: { 'cache-control': 'no-cache', 'authorization': `Basic ${encodedPat}` },
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
}

function encodePat(pat) {
    var b = new Buffer(':' + pat);
    var s = b.toString('base64');

    return s;
}