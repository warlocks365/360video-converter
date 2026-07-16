using System;
using System.Runtime.InteropServices;

public class ModernFolderPicker
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IntPtr ppv);

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName([MarshalAs(UnmanagedType.U4)] uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void GetAttributes(out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileDialog
    {
        [PreserveSig] uint Show(IntPtr hwndOwner);
        uint SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        uint SetFileTypeIndex(uint iFileType);
        uint GetFileTypeIndex(out uint piFileType);
        uint Advise(IntPtr pfde, out uint pdwCookie);
        uint Unadvise(uint dwCookie);
        uint SetOptions(uint fos);
        uint GetOptions(out uint pfos);
        uint SetDefaultFolder(IShellItem psi);
        uint SetFolder(IShellItem psi);
        uint GetFolder(out IShellItem ppsi);
        uint GetCurrentSelection(out IShellItem ppsi);
        uint SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        uint GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        uint SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        uint SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        uint SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        uint GetResult(out IShellItem ppsi);
        uint AddPlace(IShellItem psi, int fdap);
        uint SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        uint Close(int hr);
        uint SetClientGuid(ref Guid guid);
        uint ClearClientData();
        uint SetFilter(IntPtr pFilter);
    }

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    public class FileOpenDialog {}

    public static string Show(string title, string initialDir)
    {
        try
        {
            FileOpenDialog dialog = new FileOpenDialog();
            IFileDialog fd = (IFileDialog)dialog;
            // FOS_PICKFOLDERS=0x20 | FOS_FORCEFILESYSTEM=0x40 | FOS_NOCHANGEDIR=0x8
            fd.SetOptions(0x20 | 0x40 | 0x8);
            if (!string.IsNullOrEmpty(title)) fd.SetTitle(title);
            if (!string.IsNullOrEmpty(initialDir) && System.IO.Directory.Exists(initialDir))
            {
                Guid iid = typeof(IShellItem).GUID;
                IntPtr pItem;
                if (SHCreateItemFromParsingName(initialDir, IntPtr.Zero, ref iid, out pItem) == 0 && pItem != IntPtr.Zero)
                {
                    IShellItem item = (IShellItem)Marshal.GetObjectForIUnknown(pItem);
                    fd.SetFolder(item);
                }
            }
            if (fd.Show(IntPtr.Zero) == 0)
            {
                IShellItem result;
                fd.GetResult(out result);
                string path;
                // SIGDN_DESKTOPABSOLUTEEDITING = 0x8004C000
                result.GetDisplayName(0x8004C000, out path);
                return path;
            }
            return "";
        }
        catch
        {
            return "";
        }
    }
}
