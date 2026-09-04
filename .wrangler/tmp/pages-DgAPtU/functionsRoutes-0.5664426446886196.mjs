import { onRequestPost as __api_feedback_ts_onRequestPost } from "/Users/augustineliu/Local_Projects/mjrc/mjrc-game/functions/api/feedback.ts"
import { onRequestPost as __api_match_ts_onRequestPost } from "/Users/augustineliu/Local_Projects/mjrc/mjrc-game/functions/api/match.ts"
import { onRequest as ___middleware_ts_onRequest } from "/Users/augustineliu/Local_Projects/mjrc/mjrc-game/functions/_middleware.ts"

export const routes = [
    {
      routePath: "/api/feedback",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_feedback_ts_onRequestPost],
    },
  {
      routePath: "/api/match",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_match_ts_onRequestPost],
    },
  {
      routePath: "/",
      mountPath: "/",
      method: "",
      middlewares: [___middleware_ts_onRequest],
      modules: [],
    },
  ]