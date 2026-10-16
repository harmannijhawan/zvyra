import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({}));
import { needsComputerApproval, PcAction } from '../electron/computer/service';
import { parseActions } from '../electron/agents/protocol';
import { publicChatText } from '../electron/chat/tools';

describe('PC action validation and existing protocol', () => {
  it('ZVYRA permits observation but requires approval for every mutation', () => {
    expect(needsComputerApproval(PcAction.parse({action:'screenshot'}))).toBe(false);
    for (const raw of [{action:'click',x:20,y:30,intent:'Open login tab'}, {action:'type',text:'hello',intent:'Edit my project title'}]) expect(needsComputerApproval(PcAction.parse(raw))).toBe(true);
  });
  it('uses approvals for consequential actions and never approves arbitrary applications', () => {
    expect(needsComputerApproval(PcAction.parse({action:'click',x:20,y:30,intent:'Send email to customer'}))).toBe(true);
    expect(needsComputerApproval(PcAction.parse({action:'hotkey',keys:['ctrl','delete']}))).toBe(true);
    expect(needsComputerApproval(PcAction.parse({action:'key',key:'enter'}),'purchase this product')).toBe(true);
    expect(PcAction.safeParse({action:'open_application',application:'cmd.exe'}).success).toBe(false);
    expect(PcAction.safeParse({action:'wait',ms:100000}).success).toBe(false);
    expect(PcAction.safeParse({action:'click',x:NaN,y:30}).success).toBe(false);
  });
  it('uses the same action parser and keeps raw tool instructions out of chat', () => {
    const raw='Checking your PC. <computer>{"action":"screenshot"}</computer><swarm>{"action":"status"}</swarm>';
    expect(parseActions(raw).actions.map(a=>a.type)).toEqual(['computer','swarm']);
    expect(publicChatText(raw)).toBe('Checking your PC.');
    expect(publicChatText('Checking. <computer>{"act')).toBe('Checking.');
  });
});
