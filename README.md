 VsoRollupItems

Use the VSTS REST APIs to automatically do the cost roll-ups for a given backlog and to evaluate cumulative costs and project completion times based on team capacity.

Initial setup to use the tool:
1. Clone the repo. The following command will create a VsoRollupItems folder in the current working directory.
```
git clone https://github.com/johnyjosh/VsoRollupItems.git
```
2. Get the npm packages.
```
npm install
```
3. Create a config\personal_access_token.json file with {"token":"Your PAT"}. Refer [here](https://docs.microsoft.com/en-us/vsts/accounts/use-personal-access-tokens-to-authenticate) for how to do that in VSO.
4. Update config\default.json with your VSO information, namely the area path you want to run this on.

5. Run one of the two tools. Run with -h for help on the tool. It is safe to execute them without any options since by default no vso updates will be made.
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
