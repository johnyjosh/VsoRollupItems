/*
 * Program to compute cumulative sum of remaining days of the backlog in order of StackRank
 * for a given area path and iteration path.
 */
"use strict";
const path = require('path');
const _ = require('lodash');
const fs = require('fs');
const cmdargs = require('command-line-args'); // https://www.npmjs.com/package/command-line-args
const config = require('config');
const utils = require('./utils');

// Access the personal access token from a local file you need to create
// Info on how to create PAT token: https://docs.microsoft.com/en-us/vsts/accounts/use-personal-access-tokens-to-authenticate
const patFile = path.dirname(require.main.filename) + '\\config\\personal_access_token.json';
const pat = JSON.parse(fs.readFileSync(patFile));

const args = processCommandline();
if (args.help) {
    showHelp();
    return;
}

if (!args.areapath || !args.iterationpath) {
    showHelp("Both areapath and iterationpath are required parameters.");
    return;
}

// 1. Execute the query to retrieve the hierarchy of work items in the given area path.
// Note that we can't plug in any arbitrary query the code logic assumes that the query is from WorkItemLinks rather than from WorkItems.
// The other option would have been to start from all the top level items (Epics)
// and then query for children recursively and do the roll ups per top level item.

const vstsConstants = config.get('constants');
const vstsEndpointInfo = config.get('endpointInfo');
var vsoConfig = new utils.VsoConfig(vstsEndpointInfo.vstsBaseUri, vstsEndpointInfo.vstsProject, pat.token);

utils.vstsApi(
    vsoConfig,
    'POST',
    `${vstsEndpointInfo.vstsBaseUri}/${vstsEndpointInfo.vstsProject}/_apis/wit/wiql`,
    {
        query: `SELECT [System.Id]\
        FROM WorkItems \
        WHERE [System.WorkItemType] in ('Feature') and \
            [System.AreaPath] = '${args.areapath}' and \
            [System.IterationPath] = '${args.iterationpath}'\
        ORDER BY [Microsoft.VSTS.Common.StackRank] ASC`
    }
)
.then(queryResults => {
  const fieldNames = 'System.Id,System.Title,Microsoft.VSTS.Scheduling.RemainingWork,Microsoft.VSTS.Scheduling.CompletedWork,System.IterationPath,System.State,Microsoft.VSTS.Common.StackRank';

   // 3. Query for additional fields for each of the work items
   return utils.getWorkItemFields(vsoConfig, _.map(queryResults.workItems, x => x.id), fieldNames)
   .then(workItemsWithFields => {
       return {
           workItems: queryResults.workItems,
           workItemsWithFields: workItemsWithFields
       };
   })
   .catch(error => {
       console.log("Error from getWorkItemFields()");
       throw error;
   })})
.then(vsoItems => {
    var remainingDaysCumulative = 0;
    console.log('Id\tRemainingDaysCumulative\tRemainingWork\tTitle');
    _.each(vsoItems.workItems, elm => {
      var workItemDetails = vsoItems.workItemsWithFields[elm.id].fields;
      remainingDaysCumulative +=  workItemDetails['Microsoft.VSTS.Scheduling.RemainingWork'] || 0;
      console.log(`${workItemDetails['System.Id']}\t${remainingDaysCumulative}\t${workItemDetails['Microsoft.VSTS.Scheduling.RemainingWork']}\
      \t${workItemDetails['System.Title']}`);
    });
})

function showHelp(helpString) {
    if (helpString) {
        console.log(helpString);
        return;
    }

    console.log(`--help (or -h)`);
    console.log(`   Show this help.`);
    console.log('');
    console.log(`--areapath (or -p) [Required parameter]`);
    console.log(`   Provide the area path to process (for example: MSTeams\\Calling Meeting Devices (CMD)\\Broadcast).`);
    console.log('');
    console.log(`--iterationpath (or -i) [Required parameter]`);
    console.log(`   Provide the specific iteration to list out (for example: MSTeams\\2019\\Q2).`);
    console.log('');
    console.log('The program lists out the feature items in the given iteration path in the order of stackrank');
    console.log('and with a column reflecting the cummulation of costs for all items above (including current item).');
    console.log('This allows for easy cut-line evaluations.');
}

function processCommandline() {
    const options = [
        { name: 'help', alias: 'h', type: Boolean},
        { name: 'areapath', alias: 'p', type: String },
        { name: 'iterationpath', alias: 'i', type: String }
    ];
    const args = cmdargs(options);

    if (args.help) {
        return args;
    }
  
    return args;
}