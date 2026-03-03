import Settings from '@overleaf/settings'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import PrepSSOController from './PrepSSOController.mjs'

export default {
  apply(webRouter) {
    if (!Settings.prepSso?.enabled) {
      return
    }

    AuthenticationController.addEndpointToLoginWhitelist('/auth/prep')
    AuthenticationController.addEndpointToLoginWhitelist('/auth/prep/callback')

    webRouter.get('/auth/prep', PrepSSOController.start)
    webRouter.get('/auth/prep/callback', PrepSSOController.callback)
  },
}
