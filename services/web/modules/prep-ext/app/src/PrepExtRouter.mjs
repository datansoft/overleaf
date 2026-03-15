import Settings from '@overleaf/settings'
import PrepExtController from './PrepExtController.mjs'
import PrepSSORouter from './PrepSSORouter.mjs'

function addPrepManuscriptRoutes(router) {
  router.post(
    '/prep/manuscript',
    PrepExtController.requirePrepExtApiToken,
    PrepExtController.createManuscriptProject
  )
  router.delete(
    '/prep/manuscript/:project_id',
    PrepExtController.requirePrepExtApiToken,
    PrepExtController.deleteManuscriptProject
  )
  router.put(
    '/prep/manuscript/:project_id/member',
    PrepExtController.requirePrepExtApiToken,
    PrepExtController.syncManuscriptProjectMembers
  )
}

export default {
  apply(webRouter, privateApiRouter) {
    if (!Settings.prepExt?.enabled) {
      return
    }

    PrepSSORouter.apply(webRouter)

    addPrepManuscriptRoutes(privateApiRouter)
  },

  applyNonCsrfRouter(webRouter) {
    if (!Settings.prepExt?.enabled) {
      return
    }

    // Prep callbacks are authenticated via x-prep-token instead of browser CSRF.
    addPrepManuscriptRoutes(webRouter)
  },
}
