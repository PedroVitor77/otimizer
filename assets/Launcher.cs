using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

[assembly: AssemblyTitle("PulsePC Otimizador Pro")]
[assembly: AssemblyDescription("Diagnostico de Saude e Otimizador Pro para Windows")]
[assembly: AssemblyProduct("PulsePC Pro")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace PulsePC
{
    static class Program
    {
        [DllImport("shell32.dll", SetLastError = true)]
        static extern void SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string AppID);

        [STAThread]
        static void Main()
        {
            try
            {
                SetCurrentProcessExplicitAppUserModelID("PulsePC.Otimizador.Pro.1");
            }
            catch { }

            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string appPy = Path.Combine(baseDir, "app.py");

            if (!File.Exists(appPy))
            {
                MessageBox.Show(
                    "Arquivo app.py nao encontrado em:\n" + appPy,
                    "PulsePC Otimizador Pro",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string candidatePyw = Path.Combine(localAppData, @"Programs\Python\Python312\pythonw.exe");
            string pywExe = File.Exists(candidatePyw) ? candidatePyw : "pythonw.exe";

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = pywExe;
                psi.Arguments = "\"" + appPy + "\"";
                psi.WorkingDirectory = baseDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Erro ao iniciar o PulsePC:\n" + ex.Message,
                    "PulsePC Otimizador Pro",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }
    }
}
