// Rute API Mini App. Autentikasi, origin dan rate limit ditangani server.js sebelum handler jalan.
const read = (pattern, handler) => ({ method: 'GET', pattern, handler, write: false });
const write = (pattern, handler) => ({ method: 'POST', pattern, handler, write: true });

export function buildRoutes(impl) {
  return [
    read(/^\/api\/overview$/, () => impl.overview()),
    read(/^\/api\/activity$/, () => impl.activity()),
    read(/^\/api\/decisions$/, ({ query }) => impl.decisionFeed({ limit: query.get('limit'), outcome: query.get('outcome') || '' })),

    read(/^\/api\/positions$/, ({ query }) => impl.listPositions({ status: query.get('status') === 'closed' ? 'closed' : 'open', limit: query.get('limit') })),
    read(/^\/api\/positions\/(\d{1,12})$/, ({ params }) => impl.positionDetail(params[0])),
    write(/^\/api\/positions\/(\d{1,12})\/close$/, ({ params }) => impl.closePosition(params[0])),


    read(/^\/api\/intents$/, () => impl.listIntents()),

    read(/^\/api\/settings$/, () => impl.settingsView()),
    write(/^\/api\/settings$/, ({ body, actor }) => impl.changeSetting(body.key, body.value, { actor })),
    write(/^\/api\/strategy$/, ({ body, actor }) => impl.selectStrategy(body.id, { actor, enabled: body.enabled })),
    write(/^\/api\/mode$/, ({ body, actor }) => impl.changeTradingMode(body.value, { actor, confirmText: body.confirmText })),
    read(/^\/api\/changes$/, () => impl.listChanges({})),
    write(/^\/api\/changes\/(\d{1,12})\/rollback$/, ({ params, actor }) => impl.rollbackChange(params[0], { actor })),

    read(/^\/api\/dryrun$/, () => impl.dryRunWallet()),
    write(/^\/api\/dryrun\/capital$/, ({ body, actor }) => impl.setDryRunCapital(body.value, { actor })),

    read(/^\/api\/reports\/brief$/, () => impl.briefReport()),
    read(/^\/api\/reports\/intel$/, () => impl.intelReport()),
    write(/^\/api\/reports\/daily$/, () => impl.sendDailyReportToChat()),
  ];
}

export function matchRoute(routes, method, pathname) {
  let pathKnown = false;
  for (const route of routes) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    pathKnown = true;
    if (route.method === method) return { route, params: match.slice(1) };
  }
  return pathKnown ? { methodNotAllowed: true } : null;
}
