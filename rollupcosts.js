/*
 * Program to automatically roll-up cost fields for a given set of VSO work items.
 * This will recompute from the leaf nodes up, so any saved costs in the parent work items
 * is completely ignored and will get overwritten.
 * Items with all cost fields set to undefined through the roll up heirarchy will be ignored
 * (ie: the program will not overwrite those undefined fields with zeroes). This is because
 * often in a backlog the newly created items haven't been costed.
 */
"use strict";
const q = require('q');
const path = require('path');
const _ = require('lodash');
const fs = require('fs');
const cmdargs = require('command-line-args'); // https://www.npmjs.com/package/command-line-args
const config = require('config');
const utils = require('./utils');

const args = processCommandline();
if (!args) {
    return; // Return on error
}

if (args.help) {
    showHelp();
    return;
}

if (!args.config || !args.iterationpath) {
    showHelp("Both config and iterationpath are required parameters.");
    return;
}
const configInfo = JSON.parse(fs.readFileSync(args.config));

const adoInfoFile = path.dirname(require.main.filename) + '\\config\\' + config.get('adoInfoSettingsFile');
const adoInfo = JSON.parse(fs.readFileSync(adoInfoFile));

const vstsEndpointInfo = adoInfo.endpointInfo;
var vsoConfig = new utils.VsoConfig(vstsEndpointInfo.vstsBaseUri, vstsEndpointInfo.vstsProject, adoInfo.adoPersonalAccesstoken);
const fieldsToRollup = config.get('fieldsToRollup');

executeCostRollup(vsoConfig);
return;

function executeCostRollup(vsoConfig) {
    // If user specifies a query (has to be a parent-child query), then we will use that.
    // User can also just pass an area path in which case the program will execute a pre-canned query
    // and rollup costs in requirements and tasks into features.


    // 1. Execute the query to retrieve the hierarchy of work items.
    // Note that we can't plug in any arbitrary query the code logic assumes that the query is from
    // WorkItemLinks rather than from WorkItems. So the query has to be a heirarchical one.
    var queryResultsPromise;

    if (args.queryid) {
        console.log(`Processing vso items from queryid ${args.queryid}`);
        queryResultsPromise = utils.vstsApi(
            vsoConfig,
            'GET',
            `${vstsEndpointInfo.vstsBaseUri}/${vstsEndpointInfo.vstsProject}/_apis/wit/wiql/${args.queryid}`
        )
    } else if (configInfo) {
        const areaPaths = utils.getAdoListFromArray(configInfo.areaPaths);
        if (!areaPaths) {
            console.error(`areaPaths not setup correctly in  '${args.config}'`)
            throw error;
        }

        console.log(`Processing features, requirements and tasks from ${areaPaths}`);
        var queryString =
            `SELECT [System.Id] \
                FROM WorkItemLinks \
                WHERE [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward' \
                    and Source.[System.WorkItemType] in ('Feature') \
                    and Source.[System.AreaPath] in ${areaPaths} \
                    and Target.[System.AreaPath] in ${areaPaths} \
                    and Target.[System.WorkItemType] in ('Feature', 'Requirement', 'Task', 'bug')`;

        if (args.iterationpath) {
            queryString += `and Source.[System.IterationPath] = '${args.iterationpath}'`;
        }

        if (configInfo.queryExtensionForRollup) {
            queryString += ' AND ' + '(' + configInfo.queryExtensionForRollup + ')';
        }

        queryString += `MODE (Recursive)`;

        queryResultsPromise = utils.vstsApi(
            vsoConfig,
            'POST',
            `${vstsEndpointInfo.vstsBaseUri}/${vstsEndpointInfo.vstsProject}/_apis/wit/wiql`,
            {
                query: queryString
            })
    } else { // redundant check since we already validate this in the caller, but keeping for clarity of logic.
        console.error("Invalid arguments, need either backlog or queryid specified");
    }
    queryResultsPromise.then(queryResults => {
        // 2. Restructure the hierarchy info into a more convenient format that brings all
        //    the child items into one array.
        var workItemsHierarchy = {};
        console.log(`Processing ${queryResults.workItemRelations.length} items`);
        _.each(queryResults.workItemRelations, elm => {
            if (elm.rel == 'System.LinkTypes.Hierarchy-Forward') {
                // Hierarchy-Forward represents the parent-child relationship with source
                // being the parent and target being the children. Note that work items
                // with no parents have a null source but it is safe to access source.id
                // because of the elm.rel == Hierarchy-Forward check.
                workItemsHierarchy[elm.source.id] = workItemsHierarchy[elm.source.id] || [];
                workItemsHierarchy[elm.source.id].push(elm.target.id);
            }
        });

        // 3. Query for additional fields for each of the work items
        return utils.getWorkItemFields(
            vsoConfig,
            _.map(queryResults.workItemRelations, x => x.target.id),
            'System.Id,System.Title,System.WorkItemType,System.State,' + _.join(fieldsToRollup))
        .then(workItemsWithFields => {
            // We create a wrapper object vsoitems that has two objects:
            // workItemsHierarchy and workItemsWithFields
            // Both are indexed by work item ID.
            // 1. workItemsHierarchy[id] is an array of direct child work item IDs (indirect descendants not included).
            // 2. workItemsWithFields[id].fields has the cost info from VSO.
            //    workItemsWithFields[id].state is where the computed rollup and misc. state flags are maintained.
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
        printUpdatePlan(vsoItems);
        return vsoItems; // Just pass it down the chain
    })
    .then((vsoItems) => {
        if (args.safe) {
            console.log("Skipping update because safe mode is enabled.");
            return 0;
        } else {
            console.log("Writing updated costs into VSO.");
            return updateCosts(vsoItems);
        }
    })
    .then((updatedItemsCount) => {
        console.log(`Count of vso items updated: ${updatedItemsCount}`);
    })
    .catch(error => {
        console.log("Encountered an error: " + error);
    })
    .finally(() => {
        console.log(`Done`);
    });
}

function printUpdatePlan(vsoItems) {
    const shortenedFieldNames = _.map(fieldsToRollup, fieldName => _.replace(fieldName, "Microsoft.VSTS.Scheduling.", ""));
    console.log("id\t" + _.join(shortenedFieldNames, "(Old)\t") + "(Old)\t" + _.join(shortenedFieldNames, "(New)\t") + "(New)\t" + "isUpdateRequired\tworkItemType\tState\tTitle");
    _.each(vsoItems.workItemsWithFields, (workItemFields, id) => {
        var fieldValuesOld = "", fieldvaluesNew = "";
        _.each(fieldsToRollup, fieldName => {
            fieldValuesOld += workItemFields.fields[fieldName] + "\t";
            fieldvaluesNew += workItemFields.state.rollupInfo[fieldName] + "\t";
        });
        if (args.verbose || workItemFields.state.isUpdateRequired) {
            console.log(`${id}\t` + fieldValuesOld + fieldvaluesNew + `${workItemFields.state.isUpdateRequired}\t${workItemFields.fields['System.WorkItemType']}\t${workItemFields.fields['System.State']}\t"${workItemFields.fields['System.Title']}"`);
        }
    });
}

// If a valid rollup value could be computed (for example during rollup we don't even visit orphaned items),
// and if it is not the same as what is already in VSO, only then do we want to update.
function evaluateUpdateRequired(workItemFields) {
    var netSum = 0;

    var isSomeValueUpdated = _.some(fieldsToRollup, fieldName => {
        var rollupValue = workItemFields.state.rollupInfo[fieldName];
        var currentValue = workItemFields.fields[fieldName] || 0;
        netSum += rollupValue + currentValue;
        return (rollupValue != undefined && currentValue != rollupValue);
    });

    // netSum is computed across all the fields and the intent is to leave untouched any newly created epics, features, requirements, etc
    // that haven't been costed at all and all the cost fields are blank currently.
    return netSum > 0 && isSomeValueUpdated;
}

// Write the computed costs back to VSO, use batched updates for reducing round trips
function updateCosts(vsoItems) {
    const ids = _.map(vsoItems.workItemsWithFields, (v,id) => id);

    const filteredIds = _.filter(ids, (id) => vsoItems.workItemsWithFields[id].state.isUpdateRequired);
    const cappedIds = _.take(filteredIds, args.forcecap || config.get('maxUpdates'));
    if (filteredIds.length != cappedIds.length) {
        console.error(`Warning: ${filteredIds.length} updates computed, capping to ${cappedIds.length}`);
    }

    const chunkedIds = _.chunk(cappedIds, config.get('batchSize'));

    var deferred = q.defer();
    if (chunkedIds.length == 0) {
        deferred.resolve(0);
        return deferred.promise;
    }

    var resultPromises = [];

    _.each(chunkedIds, idsToUpdate => {
        const patchRequests = _.map(idsToUpdate, id => {
            var patchOp = {
                "method": "PATCH",
                "uri" : `/_apis/wit/workitems/${id}?api-version=1.0`,
                "headers": {
                    "Content-Type": "application/json-patch+json"
                }
            }

            // list of operations (one per rollup field)
            patchOp.body = _.map(fieldsToRollup, fieldName => {
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
        
        utils.vstsApi(vsoConfig, 'POST', `${vstsEndpointInfo.vstsBaseUri}/_apis/wit/$batch`, patchRequests)
        .then(x => deferred.resolve(idsToUpdate.length))
        .catch(error => deferred.reject(error));
    });

    q.all(resultPromises)
    .then(resultArray => {
        deferred.resolve(_.reduce(resultArray, (sum, x) => sum + x, 0))
    })
    .catch(error => deferred.reject(error));

    return deferred.promise;
}

function rollupCosts(vsoItems) {
    _.each(vsoItems.workItemsHierarchy, (childIds, itemId) => rollupCostsForItem(vsoItems, itemId));
}

function rollupCostsForItem(vsoItems, itemId) {
    const workItemFields = vsoItems.workItemsWithFields[itemId];
    if (workItemFields.state.isProcessed) {
        // If roll up is already done for this item, then this is a no-op call.
        return;
    }

    const hierarchyInfo = vsoItems.workItemsHierarchy[itemId];
    if (hierarchyInfo == undefined) {
        // For leaf nodes, we just copy the item's costs into the state.rollupInfo structure.
        _.each(fieldsToRollup, fieldName => workItemFields.state.rollupInfo[fieldName] = workItemFields.fields[fieldName] || 0);
    } else {
        _.each(fieldsToRollup, fieldName => workItemFields.state.rollupInfo[fieldName] = 0);

        // Go through each child, ensure that the child is processed, then add up that child's
        // cost info into the aggregate. We ensure that even leaf node item costs are copied into
        // the "rollupInfo" structure.
        _.each(hierarchyInfo, childId => {
            rollupCostsForItem(vsoItems, childId);
            _.each(fieldsToRollup, fieldName => {
                workItemFields.state.rollupInfo[fieldName] += vsoItems.workItemsWithFields[childId].state.rollupInfo[fieldName]
                workItemFields.state.rollupInfo[fieldName] = Math.round(workItemFields.state.rollupInfo[fieldName] * 100)/100;
            });
        });
    }

    workItemFields.state.isProcessed = true;
    workItemFields.state.isUpdateRequired = evaluateUpdateRequired(workItemFields);
}

function showHelp(helpString) {
    if (helpString) {
        console.log(helpString);
        return;
    }
    console.log(`--help (or -h)`);
    console.log(`   Show this help.`);
    console.log('');
    console.log(`--iterationpath (or -i) <iterationpath>`);
    console.log(`   Optional parameter to apply the rollup only to a specific iteration like MSTeams\\2021\\Q1`);    
    console.log('');
    console.log(`--config (or -c) <file>`); // Either this or queryId must be specified
    console.log(`   Pass the config file with info on which backlog to process.`);
    console.log('');
    console.log(`--queryid (or -q)`);
    console.log(`   Rollup costs for the work items returned from the given query.`);
    console.log('');
    console.log(`--safe (or -n)`);
    console.log(`   Do the rollup calculations, but don't actually commit to VSO. This is the default behavior if --apply is not explicitly specified.`);
    console.log('');
    console.log(`--apply (or -a)`);
    console.log(`   Do the rollup calculations and commit to VSO.`);
    console.log('');
    console.log(`--forcecap N (or -f N)`);
    console.log(`   Forces that no more than N entries will be updated in a single run of the program.`);
    console.log(`   Best to set some low limits like 1 or 2 items until you are sure the program is doing what you expect.`);
    console.log('');
    console.log(`--verbose (or -v)`);
    console.log(`   By default the program will spit out a tab separated table of any updates it will apply after the rollups are calculated.`);
    console.log(`   In verbose mode, the program will also show the set of rows that were computed but skipped for update because`);
    console.log(`   the computed values were the same as the old values.`);
    console.log('');
}

// Processes command line.
// Returns an object with various command line options set so that
// the rest of the code can use that to check various commandline controls.
// Returns null if there is an error in what the user has selected.
function processCommandline() {
    const options = [
        { name: 'config', alias: 'c', type: String },
        { name: 'iterationpath', alias: 'i', type: String },
        { name: 'queryid', alias: 'q', type: String },
        { name: 'forcecap', alias: 'f', type: Number },
        { name: 'verbose', alias: 'v', type: Boolean },
        { name: 'safe', alias: 'n', type: Boolean},
        { name: 'apply', alias: 'a', type: Boolean},
        { name: 'help', alias: 'h', type: Boolean}
    ];
    const args = cmdargs(options);

    if (args.help) {
        return args;
    }

    if (args.forcecap) {
        console.log(`Capping updates to max of ${args.forcecap}.`);
    }

    if (args.apply) {
        console.log(`Apply mode enabled, updates will be computed and persisted to VSO.`);
    } else {
        args.safe = true; // If "apply" is not provided, then assume safe mode by default
    }

    if (args.safe) {
        console.log(`Safe mode enabled, updates will be computed, but not persisted to VSO. Use "-h" for help.`);
    }
    
    if (args.verbose) {
        console.log(`Override the default behavior that does not show the entries that are skipped from being updated.`);
    }

    return args;
}