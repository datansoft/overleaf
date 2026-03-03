import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import UrlHelper from '../../../../app/src/Features/Helpers/UrlHelper.mjs'
import logger from '@overleaf/logger'
import { expressify } from '@overleaf/promise-utils'
import PrepSSOService, { PrepSSOError } from './PrepSSOService.mjs'

function getSafeReturnTo(req) {
  const requested = req.query.return_to
  if (typeof requested !== 'string') {
    return undefined
  }
  return UrlHelper.getSafeRedirectPath(requested)
}

async function start(req, res) {
  const returnTo = getSafeReturnTo(req)
  if (returnTo) {
    AuthenticationController.setRedirectInSession(req, returnTo)
  }

  if (SessionManager.isUserLoggedIn(req.session)) {
    return res.redirect(returnTo || '/project')
  }

  const prepStartUrl = PrepSSOService.promises.buildStartUrl(returnTo)
  return res.redirect(prepStartUrl)
}

async function callback(req, res, next) {
  try {
    const returnTo = getSafeReturnTo(req)
    if (returnTo) {
      AuthenticationController.setRedirectInSession(req, returnTo)
    }

    const token = typeof req.query.token === 'string' ? req.query.token : null
    const identity = await PrepSSOService.promises.consumeBridgeToken(token)
    const auditLog = {
      ipAddress: req.ip,
    }
    const { user, isNewUser } = await PrepSSOService.promises.findOrCreateUser(
      identity,
      auditLog
    )

    req.session.justRegistered = isNewUser
    AuthenticationController.setAuditInfo(req, {
      method: 'Prep bridge login',
    })

    return AuthenticationController.finishLogin(user, req, res, next)
  } catch (error) {
    if (error instanceof PrepSSOError) {
      logger.warn({ err: error }, 'Prep SSO callback rejected')
      return res.status(error.statusCode).send(error.message)
    }
    return next(error)
  }
}

export default {
  start: expressify(start),
  callback: expressify(callback),
}
