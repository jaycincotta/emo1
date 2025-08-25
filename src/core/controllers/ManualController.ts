import { ModeController, ControllerContext, TestResultMeta } from './ControllerTypes';

export class ManualController implements ModeController {
  name: 'manual' = 'manual';
  private ctx: ControllerContext;
  constructor(ctx: ControllerContext) { this.ctx = ctx; }
  startInitial(): void { /* idle until user presses play */ }
  handleUser(action: 'play'|'stop'|'again'|'newKey'|'exitLive'): void {
    switch(action){
      case 'play':
        this.ctx.scheduleStart({ causeNewKey: false, reason: 'play' });
        break;
      case 'again':
        // Replay cadence + same note (current key, same target) handled by upstream triggerCadence + note logic if current note exists
        this.ctx.scheduleStart({ causeNewKey: false, reason: 'again' });
        break;
      case 'newKey':
        this.ctx.scheduleStart({ causeNewKey: true, reason: 'newKey' });
        break;
      case 'stop':
      case 'exitLive':
        // nothing special
        break;
    }
  }
  onTestComplete(_meta: TestResultMeta): void { /* manual: do nothing */ }
  dispose(): void { /* no timers */ }
}
