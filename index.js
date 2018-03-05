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

  // Return if it's not a source repo
  if (!build.source.repoName) {
    return callback();
  }

  // Get original repo
  google.auth.getApplicationDefault(function(err, authClient, projectId) {
    if (err) {
      throw err;
    }

    console.log("Authenticating...");
    if (authClient.createScopedRequired && authClient.createScopedRequired()) {
      authClient = authClient.createScoped([
        "https://www.googleapis.com/auth/source.read_only",
        "https://www.googleapis.com/auth/cloud-platform"
      ]);
    }

    console.log("Accessing Source Repositories...");
    google
      .sourcerepo({
        version: "v1",
        auth: authClient
      })
      .projects.repos.get(
        {
          name: `projects/${build.source.projectId}/repos/${
            build.source.repoName
          }`
        },
        function(err, data) {
          if (err) {
            throw err;
          }
          // Get repo info
          const repo = data.data;
          // Check if there's a mirror config
          if (!(repo.mirrorConfig && repo.mirrorConfig.url)) {
            return callback();
          }
          // Get url
          const { owner, name } = GitUrlParse(repo.mirrorConfig.url);
          const ref =
            build.source.branchName ||
            build.source.tagName ||
            build.source.commitSha;

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
