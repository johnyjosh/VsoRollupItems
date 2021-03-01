 VsoRollupItems

Use the VSTS REST APIs to automatically do the cost roll-ups for a given backlog or VSO hierarchical query. There is a second tool that helps evaluate cumulative costs to make it easier to evaluate cut lines based on team capacity.

Initial setup to use the tool:
1. Clone the repo. The following command will create a VsoRollupItems folder in the current working directory.
```
git clone https://github.com/johnyjosh/VsoRollupItems.git
```
2. Get the npm packages.
```
npm install
```
3. Create a config\donotcheckin_adoinfo.json file with the relevant connection information about your ADO. Refer [here](https://docs.microsoft.com/en-us/vsts/accounts/use-personal-access-tokens-to-authenticate) for how to get your personal access token key. Here is what the adoinfo file should look like:
 
```
{
  "comment": "This file has sensitive information and should never be checked into a public github.",
  "adoPersonalAccesstoken": "...",
  "endpointInfo": {
    "vstsBaseUri": "https://{teamname}.visualstudio.com/defaultcollection",
    "vstsProject": "{projectName}"
  },
}
```

4. config\default.json shouldn't need modification unless you use a different set of fields for rollups.
The "skipTag" is used in projectcosts.js to exclude certain items from processing, especially the summarized 
The "cutlineTag" is the marker for where the script will stop processing.

5. Create a config\donotcheckin_{blah}.json file with information about the area paths you want to process and the capacity limit you want to apply for the cutline analysis from projectcosts.js:
```
{
    "comment": "This file has sensitive information and should never be checked into a public github.",
    "areaPaths" : ["path1", "path2",...],
    "capacity" : 500
}
```
You can also add two othe optional parameters:
```
"queryExtensionForRollup"     : "AND Source.[Custom.DeveloperContentOwner] NOT CONTAINS 'blah1' AND Source.[Custom.DeveloperContentOwner] NOT CONTAINS 'blah2'",
"queryExtensionForProjection" : "AND [Custom.DeveloperContentOwner] NOT CONTAINS 'blah1' AND [Custom.DeveloperContentOwner] NOT CONTAINS 'blah2'"
```

6. Run one of the two tools. Run with -h for help on the tool. It is safe to execute them without any options since by default no vso updates will be made.
```
node rollupcosts.js -h
```
```
node projectcosts.js -h
```

*Please note the following caveats:
1. There hasn't been much testing done, this is pretty raw and use it at your own risk.
2. I am using it on an area path that has 400-500 items, not sure where the breaking point is in terms of how many items it can handle in one go.
3. It isn't doing anything smart like looking only for items that changed since the last run.
4. The logic assumes a certain type of query, you can't just plugin any query and expect it to work.
