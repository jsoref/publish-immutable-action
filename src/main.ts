import * as core from '@actions/core'
import semver from 'semver'
import * as fsHelper from './fs-helper'
import * as ociContainer from './oci-container'
import * as ghcr from './ghcr-client'
import * as attest from '@actions/attest'
import * as cfg from './config'
import * as crypto from 'crypto'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const options: cfg.PublishActionOptions =
      await cfg.resolvePublishActionOptions()

    core.info(`Publishing action package version with options:`)
    core.info(cfg.serializeOptions(options))

    const semverTag: semver.SemVer = parseSemverTagFromRef(options)

    // Ensure the correct SHA is checked out for the tag we're parsing, otherwise the bundled content will be incorrect.
    await fsHelper.ensureTagAndRefCheckedOut(
      options.ref,
      options.sha,
      options.workspaceDir
    )

    const stagedActionFilesDir = fsHelper.createTempDir(
      options.runnerTempDir,
      'staging'
    )
    fsHelper.stageActionFiles(options.workspaceDir, stagedActionFilesDir)

    const archiveDir = fsHelper.createTempDir(options.runnerTempDir, 'archives')
    const archives = await fsHelper.createArchives(
      stagedActionFilesDir,
      archiveDir
    )

    const manifest = ociContainer.createActionPackageManifest(
      archives.tarFile,
      archives.zipFile,
      options.nameWithOwner,
      options.repositoryId,
      options.repositoryOwnerId,
      options.sha,
      semverTag.raw,
      new Date()
    )

    const manifestDigest = ociContainer.sha256Digest(manifest)

    // Attestations are not supported in GHES.
    if (!options.isEnterprise) {
      const { bundle, bundleDigest } = await generateAttestation(
        manifestDigest,
        semverTag.raw,
        options
      )

      const attestationCreated = new Date()
      const attestationManifest =
        ociContainer.createSigstoreAttestationManifest(
          bundle.length,
          bundleDigest,
          ociContainer.sizeInBytes(manifest),
          manifestDigest,
          attestationCreated
        )
      const referrerIndexManifest = ociContainer.createReferrerTagManifest(
        ociContainer.sha256Digest(attestationManifest),
        ociContainer.sizeInBytes(attestationManifest),
        attestationCreated
      )

      const { attestationSHA, referrerIndexSHA } = await publishAttestation(
        options,
        bundle,
        bundleDigest,
        manifest,
        attestationManifest,
        referrerIndexManifest
      )

      if (attestationSHA !== undefined) {
        core.info(`Uploaded attestation ${attestationSHA}`)
        core.setOutput('attestation-manifest-sha', attestationSHA)
      }
      if (referrerIndexSHA !== undefined) {
        core.info(`Uploaded referrer index ${referrerIndexSHA}`)
        core.setOutput('referrer-index-manifest-sha', referrerIndexSHA)
      }
    }

    const publishedDigest = await publishImmutableActionVersion(
      options,
      semverTag.raw,
      archives.zipFile,
      archives.tarFile,
      manifest
    )

    if (manifestDigest !== publishedDigest) {
      throw new Error(
        `Unexpected digest returned for manifest. Expected ${manifestDigest}, got ${publishedDigest}`
      )
    }

    core.setOutput('package-manifest-sha', publishedDigest)
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

// This action can be triggered by any workflow that specifies a tag as its GITHUB_REF.
// This includes releases, creating or pushing tags, or workflow_dispatch.
// See https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#about-events-that-trigger-workflows.
function parseSemverTagFromRef(opts: cfg.PublishActionOptions): semver.SemVer {
  const ref = opts.ref

  if (!ref.startsWith('refs/tags/')) {
    throw new Error(`The ref ${ref} is not a valid tag reference.`)
  }

  const rawTag = ref.replace(/^refs\/tags\//, '')
  const semverTag = semver.parse(rawTag.replace(/^v/, ''))
  if (!semverTag) {
    throw new Error(
      `${rawTag} is not a valid semantic version tag, and so cannot be uploaded to the action package.`
    )
  }

  return semverTag
}

async function publishImmutableActionVersion(
  options: cfg.PublishActionOptions,
  semverTag: string,
  zipFile: fsHelper.FileMetadata,
  tarFile: fsHelper.FileMetadata,
  manifest: ociContainer.OCIImageManifest
): Promise<string> {
  const manifestDigest = ociContainer.sha256Digest(manifest)

  core.info(
    `Creating GHCR package ${manifestDigest} for release with semver: ${semver}.`
  )

  const files = new Map<string, Buffer>()
  files.set(zipFile.sha256, fsHelper.readFileContents(zipFile.path))
  files.set(tarFile.sha256, fsHelper.readFileContents(tarFile.path))
  files.set(ociContainer.emptyConfigSha, Buffer.from('{}'))

  return await ghcr.uploadOCIImageManifest(
    options.token,
    options.containerRegistryUrl,
    options.nameWithOwner,
    manifest,
    files,
    semverTag
  )
}

async function publishAttestation(
  options: cfg.PublishActionOptions,
  bundle: Buffer,
  bundleDigest: string,
  subjectManifest: ociContainer.OCIImageManifest,
  attestationManifest: ociContainer.OCIImageManifest,
  referrerIndexManifest: ociContainer.OCIIndexManifest
): Promise<{
  attestationSHA: string
  referrerIndexSHA: string
}> {
  const attestationManifestDigest =
    ociContainer.sha256Digest(attestationManifest)
  const subjectManifestDigest = ociContainer.sha256Digest(subjectManifest)
  const referrerIndexManifestDigest = ociContainer.sha256Digest(
    referrerIndexManifest
  )

  core.info(
    `Publishing attestation ${attestationManifestDigest} for subject ${subjectManifestDigest}.`
  )

  const files = new Map<string, Buffer>()
  files.set(ociContainer.emptyConfigSha, Buffer.from('{}'))
  files.set(bundleDigest, bundle)

  const attestationSHA = await ghcr.uploadOCIImageManifest(
    options.token,
    options.containerRegistryUrl,
    options.nameWithOwner,
    attestationManifest,
    files
  )

  // The referrer index is tagged with the subject's digest in format sha256-<digest>
  const referrerTag = subjectManifestDigest.replace(':', '-')

  core.info(
    `Publishing referrer index ${referrerIndexManifestDigest} with tag ${referrerTag} for attestation ${attestationManifestDigest} and subject ${subjectManifestDigest}.`
  )

  const referrerIndexSHA = await ghcr.uploadOCIIndexManifest(
    options.token,
    options.containerRegistryUrl,
    options.nameWithOwner,
    referrerIndexManifest,
    referrerTag
  )

  return { attestationSHA, referrerIndexSHA }
}

async function generateAttestation(
  manifestDigest: string,
  semverTag: string,
  options: cfg.PublishActionOptions
): Promise<{
  bundle: Buffer
  bundleDigest: string
}> {
  const subjectName = `${options.nameWithOwner}@${semverTag}`
  const subjectDigest = removePrefix(manifestDigest, 'sha256:')

  core.info(`Generating attestation ${subjectName} for digest ${subjectDigest}`)

  const attestation = await attest.attestProvenance({
    subjectName,
    subjectDigest: { sha256: subjectDigest },
    token: options.token,
    sigstore: 'github',
    skipWrite: true // We will upload attestations to GHCR
  })

  const bundleArtifact = Buffer.from(JSON.stringify(attestation.bundle))

  const hash = crypto.createHash('sha256')
  hash.update(bundleArtifact)
  const bundleSHA = hash.digest('hex')

  return { bundle: bundleArtifact, bundleDigest: `sha256:${bundleSHA}` }
}

function removePrefix(str: string, prefix: string): string {
  if (str.startsWith(prefix)) {
    return str.slice(prefix.length)
  }
  return str
}
