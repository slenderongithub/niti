import { useState } from "react";
import { KeyboardAvoidingView, ScrollView } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeInDown } from "react-native-reanimated";
import { Link2 } from "lucide-react-native";
import { useStore } from "@/lib/store";
import { space, type } from "@/lib/theme";
import { Button, Card, CardContent, CardHeader, Field, Text, Wordmark } from "@/components/ui";

// Pair with a Mac: the email it was turned on with (/remote on <email>) and the code it shows. Once
// per Mac; after that the phone reconnects on its own. Laid out like the desktop app's launch screen:
// the wordmark large and left, one line under it, then a card.
export default function SignIn() {
  const insets = useSafeAreaInsets();
  const signedIn = useStore((s) => s.signedIn);
  const [email, setEmail] = useState(useStore.getState().email ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const pair = async () => {
    setBusy(true);
    setError(undefined);
    const err = await useStore.getState().pair(email, code);
    setBusy(false);
    if (err) return setError(err);
    if (router.canGoBack()) router.back();
    else router.replace("/macs");
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space(5), paddingTop: insets.top + space(16), paddingBottom: insets.bottom + space(8), gap: space(10) }}>
        <Animated.View entering={FadeInDown.duration(500)} style={{ gap: space(4) }}>
          <Wordmark size={44} />
          <Text size={type.base} tone="mutedForeground" style={{ maxWidth: 320 }}>
            Watch and steer the team running on your Mac, from here.
          </Text>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(80).duration(500)}>
          <Card>
            <CardHeader title={signedIn ? "Pair another Mac" : "Pair with your Mac"} description="In niti on your Mac, run /remote on <your email>. Enter the same email and the code it shows." />
            <CardContent style={{ gap: space(4) }}>
              <Field
                label="Email"
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                textContentType="emailAddress"
                returnKeyType="next"
              />
              <Field
                label="Code"
                mono
                value={code}
                onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                keyboardType="number-pad"
                returnKeyType="done"
                onSubmitEditing={() => void pair()}
                error={error}
                style={{ fontSize: 24, letterSpacing: 8, minHeight: 56 }}
              />
              <Button title="Pair" icon={Link2} onPress={() => void pair()} busy={busy} disabled={!email.includes("@") || code.length !== 6} />
              {signedIn && <Button variant="ghost" size="sm" title="Cancel" tone="mutedForeground" onPress={() => router.back()} />}
            </CardContent>
          </Card>
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
