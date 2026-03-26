import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import Path from 'node:path'
import fs from 'node:fs/promises'
import { jwtVerify, importSPKI } from 'jose'
import RedisWrapper from '../../../../app/src/infrastructure/RedisWrapper.mjs'
import EmailHelper from '../../../../app/src/Features/Helpers/EmailHelper.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import UserCreator from '../../../../app/src/Features/User/UserCreator.mjs'
import ProjectCreationHandler from '../../../../app/src/Features/Project/ProjectCreationHandler.mjs'
import ProjectDeleter from '../../../../app/src/Features/Project/ProjectDeleter.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import HistoryManager from '../../../../app/src/Features/History/HistoryManager.mjs'
import PrivilegeLevels from '../../../../app/src/Features/Authorization/PrivilegeLevels.mjs'
import Sources from '../../../../app/src/Features/Authorization/Sources.mjs'
import CollaboratorsGetter from '../../../../app/src/Features/Collaborators/CollaboratorsGetter.mjs'
import CollaboratorsHandler from '../../../../app/src/Features/Collaborators/CollaboratorsHandler.mjs'
import CollaboratorsInviteGetter from '../../../../app/src/Features/Collaborators/CollaboratorsInviteGetter.mjs'
import CollaboratorsInviteHandler from '../../../../app/src/Features/Collaborators/CollaboratorsInviteHandler.mjs'
import OwnershipTransferHandler from '../../../../app/src/Features/Collaborators/OwnershipTransferHandler.mjs'
import EditorRealTimeController from '../../../../app/src/Features/Editor/EditorRealTimeController.mjs'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import FileTypeManager from '../../../../app/src/Features/Uploads/FileTypeManager.mjs'
import { promiseMapWithLimit } from '@overleaf/promise-utils'
import { ObjectId } from 'mongodb'

const replayClient = RedisWrapper.client('web')
const PREP_MEMBER_ROLES = new Set(['OWNER', 'EDITOR', 'VIEWER'])
const PREP_EXT_SOURCE = 'prep-ext'

class PrepExtError extends Error {
  constructor(message, statusCode = 403) {
    super(message)
    this.name = 'PrepExtError'
    this.statusCode = statusCode
  }
}

let publicKeyPromise

function getPrepConfig() {
  if (!Settings.prepExt?.enabled) {
    throw new PrepExtError('Prep integration is disabled', 404)
  }
  if (!Settings.prepExt.publicKey) {
    throw new PrepExtError('Prep public key is not configured', 500)
  }
  return Settings.prepExt
}

async function getPublicKey() {
  if (!publicKeyPromise) {
    const { publicKey } = getPrepConfig()
    const normalizedPublicKey = publicKey.replace(/\\n/g, '\n').trim()
    publicKeyPromise = importSPKI(normalizedPublicKey, 'RS256')
  }
  return publicKeyPromise
}

function normalizeCreateProjectClaims(payload) {
  const email = EmailHelper.parseEmail(payload.email)
  const manuscriptPayload = payload.payload

  if (!email) {
    throw new PrepExtError('Invalid email claim', 403)
  }

  if (typeof manuscriptPayload !== 'object' || manuscriptPayload == null) {
    throw new PrepExtError('Missing payload claim', 400)
  }

  const { title } = manuscriptPayload
  if (typeof title !== 'string') {
    throw new PrepExtError('payload.title is required', 400)
  }

  return {
    email,
    payload: {
      title,
    },
    jti: typeof payload.jti === 'string' ? payload.jti : null,
    exp: typeof payload.exp === 'number' ? payload.exp : null,
  }
}

function normalizeSyncMemberClaims(payload) {
  const memberPayload = payload.payload
  const members = memberPayload?.members
  if (!Array.isArray(members)) {
    throw new PrepExtError('payload.members is required', 400)
  }
  if (members.length === 0) {
    throw new PrepExtError('payload.members must contain at least one member', 400)
  }

  const seenEmails = new Set()
  const normalizedMembers = []
  let ownerCount = 0

  for (const member of members) {
    const email = EmailHelper.parseEmail(member?.email)
    const role = typeof member?.role === 'string' ? member.role.toUpperCase() : null

    if (!email) {
      throw new PrepExtError('payload.members[*].email is required', 400)
    }
    if (!role || !PREP_MEMBER_ROLES.has(role)) {
      throw new PrepExtError('payload.members[*].role must be OWNER, EDITOR, or VIEWER', 400)
    }
    if (seenEmails.has(email)) {
      throw new PrepExtError(`payload.members contains duplicate email: ${email}`, 400)
    }

    if (role === 'OWNER') {
      ownerCount += 1
    }

    seenEmails.add(email)
    normalizedMembers.push({ email, role })
  }

  if (ownerCount !== 1) {
    throw new PrepExtError('payload.members must include exactly one OWNER', 400)
  }

  return {
    members: normalizedMembers,
    jti: typeof payload.jti === 'string' ? payload.jti : null,
    exp: typeof payload.exp === 'number' ? payload.exp : null,
  }
}

async function verifyToken(token) {
  if (!token || typeof token !== 'string') {
    throw new PrepExtError('token is required', 400)
  }

  const prep = getPrepConfig()

  try {
    const publicKey = await getPublicKey()
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: prep.issuer,
      audience: prep.audience,
      algorithms: ['RS256'],
    })

    return payload
  } catch (error) {
    if (error instanceof PrepExtError) {
      throw error
    }
    logger.warn(
      {
        err: {
          name: error?.name,
          message: error?.message,
          code: error?.code,
          claim: error?.claim,
          reason: error?.reason,
        },
      },
      'Prep token verify failed'
    )
    throw new PrepExtError('Prep token could not be verified', 403)
  }
}

async function markTokenAsUsed(claims) {
  if (!claims.jti || !claims.exp) {
    throw new PrepExtError('Prep token is missing jti or exp', 403)
  }

  const ttlSeconds = Math.max(1, claims.exp - Math.floor(Date.now() / 1000))
  const replayKey = `prep-ext:jti:${claims.jti}`
  const ok = await replayClient.set(replayKey, '1', 'EX', ttlSeconds, 'NX')
  if (ok !== 'OK') {
    throw new PrepExtError('Prep token has already been used', 403)
  }
}

async function createProjectFromClaims(claims) {
  const { user, created } = await findOrCreateUserByEmail(claims.email)
  if (created) {
    logger.info({ email: claims.email }, 'Prep Ext auto-created user')
  }

  const { title } = claims.payload

  try {
    const project = await ProjectCreationHandler.promises.createBlankProject(
      user._id,
      title
    )
    return project._id
  } catch (error) {
    if (
      error instanceof Errors.InvalidNameError ||
      error instanceof Errors.InvalidError
    ) {
      throw new PrepExtError(error.message, 400)
    }
    throw error
  }
}

async function createProjectFileByProjectId(projectId, { name, fsPath, isRoot }) {
  projectId = getValidProjectId(projectId)

  if (!fsPath || typeof fsPath !== 'string') {
    throw new PrepExtError('file is required', 400)
  }

  const { folderPath, entityName } = _splitEntityName(name)

  let project
  try {
    project = await ProjectGetter.promises.getProject(projectId, {
      owner_ref: 1,
      rootFolder: 1,
    })
  } catch (error) {
    if (
      error instanceof Errors.NotFoundError ||
      error instanceof Errors.ProjectNotFoundError
    ) {
      throw new PrepExtError('project not found', 404)
    }
    throw error
  }

  if (!project) {
    throw new PrepExtError('project not found', 404)
  }
  if (!project.owner_ref) {
    throw new PrepExtError('project owner not found', 500)
  }

  let folderId = project.rootFolder?.[0]?._id
  if (folderPath) {
    try {
      const { lastFolder } = await EditorController.promises.mkdirp(
        projectId,
        folderPath,
        project.owner_ref
      )
      folderId = lastFolder._id
    } catch (error) {
      if (error instanceof Errors.InvalidNameError) {
        throw new PrepExtError(error.message, 400)
      }
      throw error
    }
  }

  try {
    const { isText, encoding } = await _shouldCreateTextProjectFile(
      entityName,
      fsPath
    )

    if (isText) {
      return await _createTextProjectFile(
        projectId,
        folderId,
        entityName,
        fsPath,
        encoding,
        isRoot,
        project.owner_ref
      )
    }

    return await _createBinaryProjectFile(
      projectId,
      folderId,
      entityName,
      fsPath,
      project.owner_ref
    )
  } catch (error) {
    if (
      error instanceof Errors.InvalidNameError ||
      error instanceof Errors.InvalidError ||
      error instanceof Errors.DuplicateNameError ||
      error instanceof Errors.UnsupportedFileTypeError
    ) {
      throw new PrepExtError(error.message, 400)
    }
    if (
      error instanceof Errors.NotFoundError ||
      error instanceof Errors.ProjectNotFoundError
    ) {
      throw new PrepExtError('project not found', 404)
    }
    if (error?.message === 'project_has_too_many_files') {
      throw new PrepExtError(error.message, 422)
    }
    throw error
  }
}

function _splitEntityName(name) {
  if (!name || typeof name !== 'string') {
    throw new PrepExtError('name is required', 400)
  }

  const trimmedName = name.trim()
  if (!trimmedName) {
    throw new PrepExtError('name is required', 400)
  }
  if (trimmedName.startsWith('/') || trimmedName.endsWith('/')) {
    throw new PrepExtError('Invalid name', 400)
  }

  const normalizedPath = Path.posix.normalize(trimmedName)
  if (
    normalizedPath === '.' ||
    normalizedPath === '..' ||
    normalizedPath.startsWith('../') ||
    normalizedPath.includes('/../')
  ) {
    throw new PrepExtError('Invalid name', 400)
  }

  const segments = normalizedPath.split('/').filter(Boolean)
  if (segments.length === 0) {
    throw new PrepExtError('name is required', 400)
  }

  const entityName = segments.pop()
  if (!entityName) {
    throw new PrepExtError('Invalid name', 400)
  }

  return {
    folderPath: segments.join('/'),
    entityName,
  }
}

function _isTexDoc(name) {
  return Path.extname(name).toLowerCase() === '.tex'
}

async function _shouldCreateTextProjectFile(entityName, fsPath) {
  const fileType = await FileTypeManager.promises.getType(entityName, fsPath, null)
  return {
    isText: !fileType.binary,
    encoding: fileType.encoding,
  }
}

async function _createTextProjectFile(
  projectId,
  folderId,
  entityName,
  fsPath,
  encoding,
  isRoot,
  userId
) {
  const fileContents = await fs.readFile(fsPath, encoding ?? 'utf8')
  const doc = await EditorController.promises.addDoc(
    projectId,
    folderId,
    entityName,
    fileContents.split('\n'),
    PREP_EXT_SOURCE,
    userId
  )

  if (isRoot && _isTexDoc(entityName)) {
    await EditorController.promises.setRootDoc(projectId, doc._id)
  }
}

async function _createBinaryProjectFile(
  projectId,
  folderId,
  entityName,
  fsPath,
  userId
) {
  await EditorController.promises.addFile(
    projectId,
    folderId,
    entityName,
    fsPath,
    null,
    PREP_EXT_SOURCE,
    userId
  )
}

async function createProjectFromToken(token) {
  const payload = await verifyToken(token)
  const claims = normalizeCreateProjectClaims(payload)
  await markTokenAsUsed(claims)
  return await createProjectFromClaims(claims)
}

function getPrivilegeLevelForPrepRole(role) {
  if (role === 'EDITOR') {
    return PrivilegeLevels.READ_AND_WRITE
  }
  if (role === 'VIEWER') {
    return PrivilegeLevels.READ_ONLY
  }
  throw new PrepExtError(`Unsupported role: ${role}`, 400)
}

async function findOrCreateUserByEmail(email) {
  let user = await UserGetter.promises.getUserByAnyEmail(email, {
    _id: 1,
    email: 1,
    first_name: 1,
    last_name: 1,
  })
  if (user) {
    return { user, created: false }
  }

  user = await UserCreator.promises.createNewUser(
    {
      email,
      holdingAccount: false,
    },
    {}
  )
  return { user, created: true }
}

async function syncProjectMembers(projectId, members) {
  let allMembers = (await CollaboratorsGetter.promises.getProjectAccess(projectId)).allMembers()

  const resolvedMembers = []
  let createdUserCount = 0

  for (const member of members) {
    const { user, created } = await findOrCreateUserByEmail(member.email)
    if (created) {
      createdUserCount += 1
    }
    resolvedMembers.push({
      ...member,
      user,
      userId: user._id.toString(),
    })
  }

  const desiredOwner = resolvedMembers.find(member => member.role === 'OWNER')
  const desiredMemberIds = new Set(resolvedMembers.map(member => member.userId))

  let ownerTransferred = false
  let removedCount = 0
  let addedCount = 0
  let updatedCount = 0

  const currentOwner = allMembers.find(member => member.source === Sources.OWNER)
  if (!currentOwner) {
    throw new PrepExtError('project owner not found', 500)
  }

  if (currentOwner.id !== desiredOwner.userId) {
    await OwnershipTransferHandler.promises.transferOwnership(
      projectId,
      desiredOwner.user._id,
      {
        allowTransferToNonCollaborators: true,
        skipEmails: true,
      }
    )
    ownerTransferred = true
  }

  allMembers = (await CollaboratorsGetter.promises.getProjectAccess(projectId)).allMembers()
  for (const member of allMembers) {
    if (member.source !== Sources.INVITE) {
      continue
    }
    if (desiredMemberIds.has(member.id)) {
      continue
    }
    await CollaboratorsHandler.promises.removeUserFromProject(projectId, member.id)
    removedCount += 1
  }

  allMembers = (await CollaboratorsGetter.promises.getProjectAccess(projectId)).allMembers()
  const currentById = new Map(
    allMembers.filter(member => member.source !== Sources.TOKEN).map(member => [member.id, member])
  )

  for (const member of resolvedMembers) {
    if (member.role === 'OWNER') {
      continue
    }

    const desiredPrivilegeLevel = getPrivilegeLevelForPrepRole(member.role)
    const current = currentById.get(member.userId)
    if (!current) {
      await CollaboratorsHandler.promises.addUserIdToProject(
        projectId,
        null,
        member.user._id,
        desiredPrivilegeLevel
      )
      addedCount += 1
      continue
    }

    if (current.privilegeLevel === PrivilegeLevels.OWNER) {
      continue
    }

    if (
      current.privilegeLevel !== desiredPrivilegeLevel ||
      (desiredPrivilegeLevel === PrivilegeLevels.READ_ONLY &&
        (current.pendingEditor || current.pendingReviewer))
    ) {
      await CollaboratorsHandler.promises.setCollaboratorPrivilegeLevel(
        projectId,
        member.user._id,
        desiredPrivilegeLevel,
        {}
      )
      updatedCount += 1
    }
  }

  const invites = await CollaboratorsInviteGetter.promises.getAllInvites(projectId)
  for (const invite of invites) {
    await CollaboratorsInviteHandler.promises.revokeInvite(projectId, invite._id)
  }

  EditorRealTimeController.emitToRoom(projectId, 'project:membership:changed', {
    members: true,
    invites: invites.length > 0,
  })

  return {
    project_id: projectId,
    member_count: resolvedMembers.length,
    created_user_count: createdUserCount,
    owner_transferred: ownerTransferred,
    added_count: addedCount,
    updated_count: updatedCount,
    removed_count: removedCount,
    revoked_invite_count: invites.length,
  }
}

async function syncProjectMembersByToken(projectId, token) {
  projectId = getValidProjectId(projectId)

  const payload = await verifyToken(token)
  const claims = normalizeSyncMemberClaims(payload)
  await markTokenAsUsed(claims)

  try {
    return await syncProjectMembers(projectId, claims.members)
  } catch (error) {
    if (
      error instanceof Errors.NotFoundError ||
      error instanceof Errors.ProjectNotFoundError
    ) {
      throw new PrepExtError('project not found', 404)
    }
    throw error
  }
}

async function deleteProjectById(projectId) {
  if (!projectId || typeof projectId !== 'string') {
    throw new PrepExtError('project_id is required', 400)
  }
  if (!ObjectId.isValid(projectId)) {
    throw new PrepExtError('Invalid project_id', 400)
  }

  try {
    await ProjectDeleter.promises.deleteProject(projectId)
  } catch (error) {
    if (error instanceof Errors.NotFoundError) {
      throw new PrepExtError('project not found', 404)
    }
    throw error
  }
}

function getValidProjectId(projectId) {
  if (!projectId || typeof projectId !== 'string') {
    throw new PrepExtError('project_id is required', 400)
  }
  if (!ObjectId.isValid(projectId)) {
    throw new PrepExtError('Invalid project_id', 400)
  }
  return projectId
}

function getDocByteLength(lines) {
  if (!Array.isArray(lines)) {
    return 0
  }
  return Buffer.byteLength(lines.join('\n'), 'utf8')
}

async function getFileRefSizeByHash(projectId, hash) {
  if (!hash || typeof hash !== 'string') {
    return 0
  }

  const { contentLength } = await HistoryManager.promises.requestBlobWithProjectId(
    projectId,
    hash,
    'HEAD'
  )

  return Number.isFinite(contentLength) ? contentLength : 0
}

async function getManuscriptProjectById(projectId) {
  projectId = getValidProjectId(projectId)

  const project = await ProjectGetter.promises.getProject(projectId, {
    name: 1,
    rootFolder: 1,
    'overleaf.history.id': 1,
  })

  if (!project) {
    throw new PrepExtError('project not found', 404)
  }

  const { docs, files } = ProjectEntityHandler.getAllEntitiesFromProject(project)

  const docSizes = await promiseMapWithLimit(5, docs, async ({ doc }) => {
    try {
      const { lines } = await ProjectEntityHandler.promises.getDoc(
        projectId,
        doc._id
      )
      return getDocByteLength(lines)
    } catch (error) {
      if (error instanceof Errors.NotFoundError) {
        return 0
      }
      throw error
    }
  })

  const fileSizes = await promiseMapWithLimit(5, files, async ({ file }) => {
    try {
      return await getFileRefSizeByHash(projectId, file.hash)
    } catch (error) {
      if (error instanceof Errors.NotFoundError) {
        return 0
      }
      throw error
    }
  })

  const totalFileSize = [...docSizes, ...fileSizes].reduce(
    (sum, size) => sum + size,
    0
  )

  return {
    project_id: projectId,
    name: project.name,
    total_file_size: totalFileSize,
  }
}

const PrepExtService = {
  createProjectFromToken,
  createProjectFileByProjectId,
  deleteProjectById,
  getManuscriptProjectById,
  syncProjectMembersByToken,
}

export { PrepExtError }
export default {
  ...PrepExtService,
  promises: PrepExtService,
}
