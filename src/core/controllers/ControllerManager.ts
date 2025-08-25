import { ModeController, ControllerContext, ModeName } from './ControllerTypes';
import { ManualController } from './ManualController';
import { AutoplayController } from './AutoplayController';

export class ControllerManager {
  private current: ModeController | null = null;
  private ctx: ControllerContext;
  constructor(ctx: ControllerContext){ this.ctx = ctx; }
  switch(mode: ModeName) {
    if (this.current && this.current.name === mode) return this.current;
    this.current?.dispose();
    switch(mode){
      case 'manual': this.current = new ManualController(this.ctx); break;
      case 'autoplay': this.current = new AutoplayController(this.ctx); break;
      case 'live': /* live controller to be added */ this.current = new ManualController(this.ctx); break; // placeholder
    }
    this.current.startInitial();
    return this.current;
  }
  getController(){ return this.current; }
}
