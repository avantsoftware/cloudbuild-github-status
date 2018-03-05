const { google } = require("googleapis");
const GitUrlParse = require("git-url-parse");
const octokit = require("@octokit/rest")();

octokit.authenticate({
  type: "token",
  token: process.env.GITHUB_TOKEN
});

const STATE_MAPPER = {
  QUEUED: "pending",
  WORKING: "pending",
  SUCCESS: "success",
  FAILURE: "failure",
  CANCELLED: "failure",
  TIMEOUT: "failure",
  INTERNAL_ERROR: "error"
};

// subscribe is the main funcion called by Cloud Functions.
module.exports.subscribe = (event, callback) => {
  // const build = {
  //   status: "WORKING",
  //   statusDetail: "This is an example",
  //   source: {
  //     projectId: "avantsoft-cluster",
  //     repoName: "sales-frontend",
  //     branchName: "kubernetes-support"
  //   }
  // };
  const build = eventToBuild(event.data.data);
  console.log(build);
  // Return if it's not a source repo
  console.log(build.sourceProvenance.resolvedRepoSource);
  if (!build.sourceProvenance.resolvedRepoSource) {
    console.log("Not a build from a repo. Exiting.");
    return callback();
  }
  const source = build.sourceProvenance.resolvedRepoSource;

  google.auth.getApplicationDefault(function(err, authClient, projectId) {
    if (err) {
      console.log("Can't authenticate. Exiting.");
      throw err;
    }

    console.log("Authenticating...");
    if (authClient.createScopedRequired && authClient.createScopedRequired()) {
      authClient = authClient.createScoped([
        "https://www.googleapis.com/auth/source.read_only",
        "https://www.googleapis.com/auth/cloud-platform"
      ]);
    }

    // Get original repo
    console.log("Accessing Source Repositories...");
    google
      .sourcerepo({
        version: "v1",
        auth: authClient
      })
      .projects.repos.get(
        {
          name: `projects/${source.projectId}/repos/${source.repoName}`
        },
        function(err, data) {
          if (err) {
            throw err;
          }
          // Get repo info
          const repo = data.data;
          // Check if there's a mirror config
          if (!(repo.mirrorConfig && repo.mirrorConfig.url)) {
            console.log("No mirrorConfig for github present. Exiting.");
            return callback();
          }
          // Get url
          const { owner, name } = GitUrlParse(repo.mirrorConfig.url);

          const ref = source.branchName || source.tagName || source.commitSha;

          console.log(
            `Repo info:\nOwner: ${owner}\nRepo: ${name}\nRef: ${ref}`
          );
          // Get sha for ref
          octokit.repos.getShaOfCommitRef(
            {
              owner,
              repo: name,
              ref
            },
            function(err, result) {
              if (err) {
                throw err;
              }
              const commitSha = result.data.sha;
              console.log(`Commit SHA: ${commitSha}`);
              // Set status on github
              octokit.repos.createStatus(
                {
                  owner,
                  repo: name,
                  sha: commitSha,
                  state: STATE_MAPPER[build.status],
                  description: build.statusDetail,
                  target_url: build.logUrl,
                  context: "ci/cloudbuild"
                },
                callback
              );
            }
          );
        }
      );
  });
};

// eventToBuild transforms pubsub event message to a build object.
const eventToBuild = data => {
  return JSON.parse(new Buffer(data, "base64").toString());
};
