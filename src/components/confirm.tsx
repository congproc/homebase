import {createContext, useCallback, useContext, useRef, useState} from 'react';
import {Dialog, DialogContent, DialogTitle, DialogDescription} from '@/components/ui/dialog';

type Options = {title: string; body: React.ReactNode; confirm: string; destructive?: boolean};
const Ctx = createContext<(o: Options) => Promise<boolean>>(async () => false);

/** `const confirm = useConfirm(); if (await confirm({...})) doIt();` */
export const useConfirm = () => useContext(Ctx);

export function ConfirmProvider({children}: {children: React.ReactNode}) {
  const [opts, setOpts] = useState<Options | null>(null);
  const resolver = useRef<(v: boolean) => void>(() => {});
  const ask = useCallback((o: Options) => new Promise<boolean>(resolve => { resolver.current = resolve; setOpts(o); }), []);
  const close = (v: boolean) => { resolver.current(v); setOpts(null); };
  return (
    <Ctx.Provider value={ask}>
      {children}
      <Dialog open={!!opts} onOpenChange={o => !o && close(false)}>
        <DialogContent>
          <DialogTitle>{opts?.title}</DialogTitle>
          <DialogDescription asChild><div className="confirm-body">{opts?.body}</div></DialogDescription>
          <div className="dialog-actions">
            <button className="button" onClick={() => close(false)}>Cancel</button>
            <button className={`button ${opts?.destructive ? 'destructive' : 'primary'}`} autoFocus onClick={() => close(true)}>{opts?.confirm}</button>
          </div>
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  );
}
