import { useState } from "react";
import { KeyboardAvoidingView, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useStore } from "@/lib/store";
import { space } from "@/lib/theme";
import { Button, Field, Text } from "@/components/ui";

// Sign in once: the same email as on the Mac, then the code from the inbox. The Mac then asks to
// allow this phone, showing a code to compare with the one on the next screen.
export default function SignIn() {
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
      <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space(5), gap: space(5) }}>
        <Text tone="muted">Control niti on your Mac from here. Use the email you signed in with there (/remote login).</Text>
        {step === "email" ? (
          <>
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
              returnKeyType="send"
              onSubmitEditing={() => void sendCode()}
              error={error}
            />
            <Field label="Relay" value={relay} onChangeText={setRelay} autoCapitalize="none" autoCorrect={false} keyboardType="url" hint="The same relay your Mac uses." />
            <Button title="Send code" onPress={() => void sendCode()} busy={busy} disabled={!email.includes("@") || !relay} />
          </>
        ) : (
          <>
            <Text>We sent a 6-digit code to {email}.</Text>
            <Field
              label="Code"
              value={code}
              onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              autoFocus
              error={error}
              style={{ fontSize: 24, letterSpacing: 6 }}
            />
            <Button title="Sign in" onPress={() => void verify()} busy={busy} disabled={code.length !== 6} />
            <View style={{ flexDirection: "row", gap: space(2) }}>
              <Button kind="ghost" title="Send again" onPress={() => void sendCode()} />
              <Button kind="ghost" title="Change email" onPress={() => (setStep("email"), setCode(""), setError(undefined))} />
            </View>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
