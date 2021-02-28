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
const { cpuUsage } = require('process');
const { update } = require('lodash');

// Access the personal access token and other sensitive info from a local file you need to create
// Info on how to create PAT token: https://docs.microsoft.com/en-us/vsts/accounts/use-personal-access-tokens-to-authenticate
const configInfoFile = path.dirname(require.main.filename) + '\\config\\donotcheckin.json';
const configInfo = JSON.parse(fs.readFileSync(configInfoFile));

const args = processCommandline();
if (args.help) {
    showHelp();
    return;
}

if (!args.backlog || !args.iterationpath) {
    showHelp("Both backlog and iterationpath are required parameters.");
    return;
}

// 1. Execute the query to retrieve the hierarchy of work items in the given area path.
// Note that we can't plug in any arbitrary query the code logic assumes that the query is from WorkItemLinks rather than from WorkItems.
// The other option would have been to start from all the top level items (Epics)
// and then query for children recursively and do the roll ups per top level item.

const vstsConstants = config.get('constants');
const vstsEndpointInfo = configInfo.endpointInfo;
var vsoConfig = new utils.VsoConfig(vstsEndpointInfo.vstsBaseUri, vstsEndpointInfo.vstsProject, configInfo.token);

if (configInfo.backlogs === undefined || configInfo.backlogs[args.backlog] === undefined) {
    console.error(`Please configure backlog information into ${configInfoFile} for "${args.backlog}"`);
    throw error;
}

const capacity = configInfo.backlogs[args.backlog].capacity;
if (!capacity) {
    console.warn(`Capacity not setup for '${args.backlog}'`); 
}

const areaPaths = utils.getAdoListFromArray(configInfo.backlogs[args.backlog].areaPaths);
if (!areaPaths) {
    console.error(`areaPaths not setup correctly for '${args.backlog}'`)
    throw error;
}

var queryString = `SELECT [System.Id]\
    FROM WorkItems \
    WHERE [System.WorkItemType] in ('Feature') \
        and [System.AreaPath] in ${areaPaths} \
        and [System.IterationPath] = '${args.iterationpath}'\
        and [System.Tags] NOT CONTAINS 'skip'`;

if (configInfo.skipFilter) {
    queryString += configInfo.skipFilter;
}

queryString += `ORDER BY [Microsoft.VSTS.Common.StackRank] ASC`;

utils.vstsApi(
    vsoConfig,
    'POST',
    `${vstsEndpointInfo.vstsBaseUri}/${vstsEndpointInfo.vstsProject}/_apis/wit/wiql`,
    {
        query: queryString
    }
)
.then(queryResults => {
  const fieldNames = 'System.Id,System.Title,Microsoft.VSTS.Scheduling.RemainingWork,Microsoft.VSTS.Scheduling.CompletedWork,\
System.IterationPath,System.State,Custom.CommittedTargettedCut,Custom.ReleaseType,\
Custom.InvestmentArea,Microsoft.VSTS.Common.StackRank';

   // 2. Query for additional fields for each of the work items
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

    var commitmentLevel = new DataSlicer('Commitment Level');
    var releaseType = new DataSlicer('Release type');
    var investmentArea = new DataSlicer('Investment Area');

    var releaseTypeCommitted = new DataSlicer('Release type Committed');
    var releaseTypeTargeted = new DataSlicer('Release type Targeted');

    var hasCutlineRendered = false;

    _.each(vsoItems.workItems, elm => {
      const workItemDetails = vsoItems.workItemsWithFields[elm.id].fields;
      const remainingDays = workItemDetails['Microsoft.VSTS.Scheduling.RemainingWork'] || 0;

      if (!hasCutlineRendered && capacity && (remainingDaysCumulative + remainingDays >= capacity)) {
        console.log(`--------------CUT LINE Capacity: ${capacity}, cost: ${remainingDaysCumulative}--------------`);
        hasCutlineRendered = true;
      }  

      remainingDaysCumulative += remainingDays;

      console.log(`${workItemDetails['System.Id']}\t${remainingDaysCumulative}\t${remainingDays}\
        \t${workItemDetails['System.Title']}`);

      const committedKey = workItemDetails['Custom.CommittedTargettedCut'] || '<empty>';
      const releaseTypeKey = workItemDetails['Custom.ReleaseType'] || '<empty>';
      const investmentAreaKey = workItemDetails['Custom.InvestmentArea'] || '<empty>';
      
      commitmentLevel.addItem(committedKey, remainingDays, elm.id);
      releaseType.addItem(releaseTypeKey, remainingDays, elm.id);
      if (committedKey == 'Committed') {
        releaseTypeCommitted.addItem(releaseTypeKey, remainingDays, elm.id);
      } else if (committedKey == 'Targeted') {
        releaseTypeTargeted.addItem(releaseTypeKey, remainingDays, elm.id);
      }
      investmentArea.addItem(investmentAreaKey, remainingDays, elm.id);
    });

    commitmentLevel.print();
    releaseType.print();
    releaseTypeCommitted.print();
    releaseTypeTargeted.print();
    investmentArea.print();
})


class DataSlicer {
    constructor(name) {
        this.name = name;
        this.total = 0;
        this.totalCount = 0;
        this.buckets = {};
    }

    addItem(key, value, id) {
        this.total += value;
        this.totalCount++;
        if (this.buckets[key] === undefined) {
            this.buckets[key] = {value:0, count:0, ids:[]};
        }
        this.buckets[key].value += value;
        this.buckets[key].count++;
        this.buckets[key].ids.push(id);
    }

    print() {
        console.log(`\n------------- ${this.name} -------------`);
    
        console.log("Days:");
        for (let key in this.buckets) {
            const value = this.buckets[key].value;
            console.log(`${key},\t${value},\t${(value * 100/this.total).toFixed(0)}%`);
        }

        console.log();
        console.log("Count:");
        for (let key in this.buckets) {
            const ids = this.buckets[key].ids;
            const count = this.buckets[key].count;
            console.log(`${key},\t${count},\t${(count * 100/this.totalCount).toFixed(0)}%`);
            //console.log(ids.join(",")); (debug only)
        }
    }

}


function showHelp(helpString) {
    if (helpString) {
        console.log(helpString);
        return;
    }

    console.log(`--help (or -h)`);
    console.log(`   Show this help.`);
    console.log('');
    console.log(`--backlog (or -b) <broadcast | transcript> [Required parameter]`);
    console.log(`   Pass the backlog to process. The backlog name need to be registered in the config.`);
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
        { name: 'backlog', alias: 'b', type: String },
        { name: 'iterationpath', alias: 'i', type: String }
    ];
    const args = cmdargs(options);

    if (args.help) {
        return args;
    }
  
    return args;
}