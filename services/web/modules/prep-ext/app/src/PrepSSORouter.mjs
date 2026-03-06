import Settings from '@overleaf/settings'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import PrepSSOController from './PrepSSOController.mjs'

export default {
  apply(webRouter) {
    if (!Settings.prepExt?.enabled) {
      return
    }

    AuthenticationController.addEndpointToLoginWhitelist('/prep/auth')
    AuthenticationController.addEndpointToLoginWhitelist('/prep/auth/callback')

    webRouter.get('/prep/auth', PrepSSOController.start)
    webRouter.get('/prep/auth/callback', PrepSSOController.callback)
  },
}
