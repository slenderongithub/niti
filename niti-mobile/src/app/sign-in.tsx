import { useState } from "react";
import { KeyboardAvoidingView, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeInDown } from "react-native-reanimated";
import { ArrowRight, Mail } from "lucide-react-native";
import { useStore } from "@/lib/store";
import { space, type } from "@/lib/theme";
import { Button, Card, CardContent, CardHeader, Field, Text, Wordmark } from "@/components/ui";

// Sign in once: the same email as on the Mac, then the code from the inbox. Laid out like the
// desktop app's launch screen: the wordmark large and left, one line under it, then a card.
export default function SignIn() {
  const insets = useSafeAreaInsets();
  const relay = useStore((s) => s.relay);
  const setRelay = useStore((s) => s.setRelay);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const sendCode = async () => {
    setBusy(true);
    setError(undefined);
    const err = await useStore.getState().startSignIn(email);
    setBusy(false);
    if (err) setError(err);
    else setStep("code");
  };

  const verify = async () => {
    setBusy(true);
    const err = await useStore.getState().finishSignIn(code);
    setBusy(false);
    if (err) setError(err);
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
            {step === "email" ? (
              <>
                <CardHeader title="Sign in" description="Use the email you signed in with on your Mac (/remote login)." />
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
                    returnKeyType="send"
                    onSubmitEditing={() => void sendCode()}
                    error={error}
                  />
                  <Field label="Relay" mono value={relay} onChangeText={setRelay} placeholder="https://" autoCapitalize="none" autoCorrect={false} keyboardType="url" hint="The same relay your Mac uses." style={{ fontSize: 14 }} />
                  <Button title="Send code" icon={Mail} onPress={() => void sendCode()} busy={busy} disabled={!email.includes("@") || !relay} />
                </CardContent>
              </>
            ) : (
              <>
                <CardHeader title="Check your inbox" description={`We sent a 6-digit code to ${email}.`} />
                <CardContent style={{ gap: space(4) }}>
                  <Field
                    label="Code"
                    mono
                    value={code}
                    onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
                    keyboardType="number-pad"
                    textContentType="oneTimeCode"
                    autoComplete="one-time-code"
                    autoFocus
                    error={error}
                    style={{ fontSize: 24, letterSpacing: 8, minHeight: 56 }}
                  />
                  <Button title="Sign in" icon={ArrowRight} onPress={() => void verify()} busy={busy} disabled={code.length !== 6} />
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Button variant="ghost" size="sm" title="Send again" onPress={() => void sendCode()} tone="mutedForeground" />
                    <Button variant="ghost" size="sm" title="Change email" onPress={() => (setStep("email"), setCode(""), setError(undefined))} tone="mutedForeground" />
                  </View>
                </CardContent>
              </>
            )}
          </Card>
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
