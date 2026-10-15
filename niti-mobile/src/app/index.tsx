import { Redirect } from "expo-router";
import { useStore } from "@/lib/store";

export default function Index() {
  const signedIn = useStore((s) => s.signedIn);
  return <Redirect href={signedIn ? "/macs" : "/sign-in"} />;
}
