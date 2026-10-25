/** Compiled once inside PcControl's existing persistent PowerShell helper. */
export const NATIVE_INPUT = String.raw`
public static class ZvyraInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int x, y; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEY { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY key; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int height, bool repaint);
  static void Send(INPUT i) { if (SendInput(1, new INPUT[]{ i }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Exception("Windows refused input (check focus, integrity level and interactive desktop)"); }
  public static void Mouse(int x, int y, uint flags, int data) {
    Send(new INPUT { type=0, u=new UNION { mouse=new MOUSE { x=x, y=y, flags=flags, data=unchecked((uint)data) } } });
  }
  public static void Move(double x, double y) {
    int left=GetSystemMetrics(76), top=GetSystemMetrics(77), w=GetSystemMetrics(78), h=GetSystemMetrics(79);
    if (x<left || y<top || x>=left+w || y>=top+h) throw new Exception("Point is outside the virtual desktop");
    // MOVE_NOCOALESCE preserves intermediate geometry instead of allowing
    // Windows to collapse a busy application's mouse moves to the endpoint.
    Mouse((int)Math.Round((x-left)*65535/Math.Max(1,w-1)), (int)Math.Round((y-top)*65535/Math.Max(1,h-1)), 0xE001, 0);
  }
  public static void Release() { Mouse(0,0,0x04|0x10|0x40,0); }
  public static double[] SmoothMove(double x,double y,string cancel,long hwnd) {
    Check(cancel,hwnd);
    int left=GetSystemMetrics(76),top=GetSystemMetrics(77),w=GetSystemMetrics(78),h=GetSystemMetrics(79);
    if(x<left||y<top||x>=left+w||y>=top+h)throw new Exception("Point is outside the virtual desktop");
    POINT start;GetCursorPos(out start);
    double distance=Math.Sqrt((x-start.x)*(x-start.x)+(y-start.y)*(y-start.y));
    double duration=distance<2?0:Math.Min(550,Math.Max(140,80+distance*0.24));
    var timer=System.Diagnostics.Stopwatch.StartNew();double lastX=start.x,lastY=start.y;int samples=0;
    do {
      Check(cancel,hwnd);POINT actual;GetCursorPos(out actual);
      if(Math.Abs(actual.x-lastX)>6||Math.Abs(actual.y-lastY)>6)throw new Exception("Mouse moved by the user; observe again before input");
      double t=duration==0?1:Math.Min(1,timer.Elapsed.TotalMilliseconds/duration);
      // Smoothstep has zero velocity at both ends. These are real, paced
      // SendInput cursor positions, never a renderer cursor animation.
      double ease=t*t*(3-2*t);lastX=Math.Round(start.x+(x-start.x)*ease);lastY=Math.Round(start.y+(y-start.y)*ease);
      Move(lastX,lastY);
      // SendInput queues a move; GetCursorPos can still expose the previous
      // sample on a busy desktop. Wait for delivery before the next user-
      // movement check instead of interpreting our queued move as interference.
      var delivered=System.Diagnostics.Stopwatch.StartNew();
      do { Check(cancel,hwnd);GetCursorPos(out actual);if(Math.Abs(actual.x-lastX)<=2&&Math.Abs(actual.y-lastY)<=2)break;System.Threading.Thread.Sleep(1); } while(delivered.ElapsedMilliseconds<40);
      if(Math.Abs(actual.x-lastX)>2||Math.Abs(actual.y-lastY)>2)throw new Exception("Mouse did not reach its target; observe again");
      samples++;if(t>=1)break;
      System.Threading.Thread.Sleep(8);
    } while(true);
    POINT end;GetCursorPos(out end);
    if(Math.Abs(end.x-x)>2||Math.Abs(end.y-y)>2)throw new Exception("Mouse did not reach its target; observe again");
    return new double[]{timer.Elapsed.TotalMilliseconds,samples,end.x,end.y};
  }
  public static void Click(int x,int y,string button,int count,long hwnd) {
    Move(x,y); uint down=button=="right"?8u:button=="middle"?32u:2u;bool held=false;
    System.Threading.Thread.Sleep(16);
    if(hwnd!=0&&GetForegroundWindow().ToInt64()!=hwnd)throw new Exception("Foreground window changed before click; observe again");
    try { for(int i=0;i<count;i++) { Mouse(0,0,down,0);held=true;System.Threading.Thread.Sleep(24);Mouse(0,0,down*2,0);held=false;if(i+1<count)System.Threading.Thread.Sleep(65); } }
    finally { if(held)Mouse(0,0,down*2,0); }
  }
  public static void Text(string text, string cancel, long hwnd) {
    text=text.Replace("\r\n","\n").Replace('\n','\r');
    for(int offset=0;offset<text.Length;offset+=32) {
      Check(cancel,hwnd);
      int count=Math.Min(32,text.Length-offset);var batch=new INPUT[count*2];
      for(int i=0;i<count;i++) {
        batch[i*2]=new INPUT{type=1,u=new UNION{key=new KEY{scan=text[offset+i],flags=4}}};
        batch[i*2+1]=new INPUT{type=1,u=new UNION{key=new KEY{scan=text[offset+i],flags=6}}};
      }
      // One atomic SendInput call keeps UTF-16 down/up pairs and combining
      // sequences ordered; physical input cannot interleave between the pairs.
      if(SendInput((uint)batch.Length,batch,Marshal.SizeOf(typeof(INPUT)))!=batch.Length)throw new Exception("Windows refused Unicode input");
      System.Threading.Thread.Sleep(2);
    }
  }
  static void Check(string cancel,long hwnd) {
    if (System.IO.File.Exists(cancel)) throw new OperationCanceledException("Computer input cancelled");
    if (hwnd!=0 && GetForegroundWindow().ToInt64()!=hwnd) throw new Exception("Foreground window changed; observe again before continuing");
  }
  public static double[] Draw(double[][] points, bool[] starts, double speed, double hz, string cancel, long hwnd) {
    bool held=false; var timer=System.Diagnostics.Stopwatch.StartNew(); double due=0; int sent=0;
    try {
      for(int i=0;i<points.Length;i++) {
        Check(cancel,hwnd);
        if(starts[i]) {
          if(held) { Mouse(0,0,4,0); held=false; }
          Move(points[i][0],points[i][1]);
          // Let the destination app consume hover/focus before the down event.
          System.Threading.Thread.Sleep(8); Check(cancel,hwnd);
          Mouse(0,0,2,0); held=true; due=timer.Elapsed.TotalMilliseconds;
        } else {
          double dx=points[i][0]-points[i-1][0], dy=points[i][1]-points[i-1][1];
          due+=Math.Max(1000/hz,Math.Sqrt(dx*dx+dy*dy)/speed*1000);
          while(timer.Elapsed.TotalMilliseconds<due) { Check(cancel,hwnd); System.Threading.Thread.Sleep(1); }
          Check(cancel,hwnd);
          POINT current;GetCursorPos(out current);
          if(Math.Abs(current.x-points[i-1][0])>3||Math.Abs(current.y-points[i-1][1])>3)throw new Exception("Cursor changed outside this stroke; input stopped to preserve the path");
          Move(points[i][0],points[i][1]);
          // If an application or Windows stalls, do not burst old waypoints into its queue.
          due=Math.Max(due,timer.Elapsed.TotalMilliseconds-1000/hz);
        }
        sent++;
      }
      System.Threading.Thread.Sleep(8);
    } finally { if(held) Mouse(0,0,4,0); }
    POINT p; GetCursorPos(out p);
    return new double[]{timer.Elapsed.TotalMilliseconds,sent,p.x,p.y};
  }
}
`
