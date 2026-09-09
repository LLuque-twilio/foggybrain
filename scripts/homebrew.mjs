import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

try {
  if (process.argv.length !== 4) {
    throw new Error(
      'Usage: node scripts/homebrew.mjs /path/foggybrain-X.Y.Z.tgz /output/foggybrain.rb',
    );
  }
  const archive = resolve(process.argv[2]);
  const metadata = JSON.parse(
    execFileSync('tar', ['-xOzf', archive, 'package/package.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    }),
  );
  if (
    metadata?.name !== 'foggybrain' ||
    metadata.private !== true ||
    !metadata.bin ||
    Object.keys(metadata.bin).length !== 1 ||
    metadata.bin.foggy !== './bin/foggy.mjs'
  ) {
    throw new Error('Expected private package foggybrain with bin { "foggy": "./bin/foggy.mjs" }');
  }
  const version = metadata.version;
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Expected a stable numeric X.Y.Z version; skip this generator for prereleases');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const formula = `class Foggybrain < Formula
  desc "Local task graphs with GitHub merge gates"
  homepage "https://github.com/LLuque-twilio/foggybrain"
  url "https://github.com/LLuque-twilio/foggybrain/releases/download/v${version}/foggybrain-${version}.tgz"
  sha256 "${hash.digest('hex')}"
  license "MIT"

  depends_on "node@22"

  def install
    ENV["npm_config_ignore_scripts"] = "true"
    system "npm", "install", *std_npm_args(prefix: libexec),
           "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"
    bin.install libexec/"bin/foggy"
    bin.env_script_all_files libexec/"bin", PATH: "#{formula_opt_bin("node@22")}:$PATH"
  end

  test do
    require "json"
    require "open3"

    ENV.keys.grep(/\\A(?:FOGGY_|GH_|GITHUB_|XDG_|NODE_)/).each { |key| ENV.delete(key) }
    home = testpath/"home"
    ENV["HOME"] = home.to_s
    ENV["XDG_CONFIG_HOME"] = (home/".config").to_s
    ENV["XDG_DATA_HOME"] = (home/".local/share").to_s
    ENV["XDG_STATE_HOME"] = (home/".local/state").to_s
    ENV["XDG_CACHE_HOME"] = (home/".cache").to_s
    ENV["GH_CONFIG_DIR"] = (home/".config/gh").to_s
    ENV["FOGGY_DATA_DIR"] = (home/"data").to_s
    %w[GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN FOGGY_SYNC_TOKEN].each do |key|
      ENV[key] = ""
    end
    home.mkpath
    ENV["PATH"] = "/usr/bin:/bin"

    assert_match "Usage: foggy", shell_output("#{bin}/foggy --help")
    stdout, stderr, status = Open3.capture3((bin/"foggy").to_s, "--json", "setup")
    assert_equal 1, status.exitstatus
    assert_empty stdout
    assert_match "--json setup is not supported", JSON.parse(stderr).fetch("error")
    stdout, _stderr, status = Open3.capture3((bin/"foggy").to_s, "--json", "stop")
    assert_predicate status, :success?
    assert_equal({ "stopped" => [], "ignored" => 0 }, JSON.parse(stdout))
    refute_path_exists home/"data"
    refute_path_exists home/".config/foggybrain/.env"
  end
end
`;
  if (resolve(process.argv[3]) === archive)
    throw new Error('Output must not overwrite the archive');
  await writeFile(process.argv[3], formula);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
