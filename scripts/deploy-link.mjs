const input = process.argv[2];
if (!input || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(input))
  throw new Error(
    "Supply the public GitHub source repository URL: https://github.com/OWNER/REPOSITORY",
  );
const repository = input.replace(/\/$/, "");
console.log(
  `[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(repository)})`,
);
console.log(`Source: ${repository}`);
console.log(`Downloads: ${repository}/releases/latest`);
