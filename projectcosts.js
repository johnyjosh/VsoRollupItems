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

const args = processCommandline();
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

const capacity = configInfo.capacity;
if (!capacity) {
    console.warn(`Need capacity property from ${args.config} for cut line calculation.`); 
}

const areaPaths = utils.getAdoListFromArray(configInfo.areaPaths);
if (!areaPaths) {
    console.error(`areaPaths not setup correctly in  '${args.config}'`)
    throw error;
}

var queryString = `SELECT [System.Id]\
    FROM WorkItems \
    WHERE [System.WorkItemType] in ('Feature') \
        and [System.AreaPath] in ${areaPaths} \
        and [System.IterationPath] under '${args.iterationpath}'`;

if (configInfo.queryExtensionForProjection) {
    queryString += ' AND ' + '(' + configInfo.queryExtensionForProjection + ')';
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
System.IterationPath,System.State,Custom.CommittedTargettedCut,Custom.ReleaseType,System.Tags,\
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
    console.log('Id\tRemainingDaysCumulative\tRemainingWork\tInvestment\tCommittedTargetted\tRelease\tTitle');

    var commitmentLevel = new DataSlicer('Commitment Level');
    var releaseType = new DataSlicer('Release type');
    var investmentArea = new DataSlicer('Investment Area');

    var releaseTypeCommitted = new DataSlicer('Release type for Committed items');
    var releaseTypeTargeted = new DataSlicer('Release type for Targeted items');

    var hasCutlineRendered = false;
    var stopProcessing = false;

    var skipTagName = config.get('skipTag');
    var cutlineTagName = config.get('cutlineTag');

    _.each(vsoItems.workItems, elm => {
      const workItemDetails = vsoItems.workItemsWithFields[elm.id].fields;
      const remainingDays = workItemDetails['Microsoft.VSTS.Scheduling.RemainingWork'] || 0;

      var tags = workItemDetails['System.Tags'];

      var skipTag = false;
      if (tags && tags.search(skipTagName) >= 0) {
        skipTag = true;
      }

      // First check if we've reached capacity in which case draw our computed cut line first
      if (!hasCutlineRendered && capacity && (remainingDaysCumulative + remainingDays > capacity)) {
        // We don't want to compute stats beyond the computed cut line
        console.log(`--------------Cutline: Capacity: ${capacity}, Cost: ${remainingDaysCumulative}--------------`);
        hasCutlineRendered = true;
        stopProcessing = true;
      }

      remainingDaysCumulative += remainingDays;

      // Next display the item with all the key properties
      var committedKey = workItemDetails['Custom.CommittedTargettedCut'] || '<empty>';
      var investmentAreaKey = workItemDetails['Custom.InvestmentArea'] || '<empty>';
      var releaseTypeKey = workItemDetails['Custom.ReleaseType'] || '<empty>';

      if (skipTag === true) {
        committedKey = "N/A";
        investmentAreaKey = "N/A";
        releaseTypeKey = "N/A";
      }

      console.log(`${workItemDetails['System.Id']}\t${remainingDaysCumulative}\t${remainingDays}\
        \t${workItemDetails['System.State']}\t${investmentAreaKey}\t${committedKey}\t${releaseTypeKey}\t${workItemDetails['System.Title']}`);
  
      if (committedKey === "Hard Cut" || skipTag) {
        // We don't want to compute stats for hard cut items
        // Also skip over any separator items that are put into backlog for visual delineation and aren't real feature items
        return true;
      }

      if (tags && (tags.search(cutlineTagName) >= 0)) {
        // We don't want to compute stats beyond the user set cut line or hard cut items
        console.log(`--------------user defined cutline--------------`);
        stopProcessing = true;
        return true;
      }

      if (!stopProcessing) {
        commitmentLevel.addItem(committedKey, remainingDays, elm.id);
        releaseType.addItem(releaseTypeKey, remainingDays, elm.id);
        if (committedKey == 'Committed') {
            releaseTypeCommitted.addItem(releaseTypeKey, remainingDays, elm.id);
        } else if (committedKey == 'Targeted') {
            releaseTypeTargeted.addItem(releaseTypeKey, remainingDays, elm.id);
        }
        investmentArea.addItem(investmentAreaKey, remainingDays, elm.id);
      }
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
    console.log(`--config (or -c) <file> [Required parameter]`);
    console.log(`   Pass the config file with info on which backlog to process.`);
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
        { name: 'config', alias: 'c', type: String },
        { name: 'iterationpath', alias: 'i', type: String }
    ];
    const args = cmdargs(options);

    if (args.help) {
        return args;
    }
  
    return args;
}