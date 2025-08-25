import { ModeController, ControllerContext, TestResultMeta } from './ControllerTypes';

export class AutoplayController implements ModeController {
  name: 'autoplay' = 'autoplay';
  private ctx: ControllerContext;
  private pending = false;
  constructor(ctx: ControllerContext) { this.ctx = ctx; }
  startInitial(): void {
    // Start first autoplay test only when user presses play (explicit UX choice)
  }
  handleUser(action: 'play'|'stop'|'again'|'newKey'|'exitLive'): void {
    switch(action){
      case 'play':
        if (!this.pending) this.ctx.scheduleStart({ causeNewKey: false, reason: 'play' });
        break;
      case 'again':
        this.ctx.scheduleStart({ causeNewKey: false, reason: 'again' });
        break;
      case 'newKey':
        this.ctx.scheduleStart({ causeNewKey: true, reason: 'newKey' });
        break;
      case 'stop':
        this.pending = false;
        break;
      case 'exitLive':
        break;
    }
  }
  onTestComplete(_meta: TestResultMeta): void {
    // Controller-driven chaining would go here in future phase.
  }
  dispose(): void { this.pending = false; }
}
