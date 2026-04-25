import Navbar from "../components/Navbar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Navbar />
      <div className="pt-[57px] pl-14 h-screen overflow-hidden">{children}</div>
    </>
  );
}
