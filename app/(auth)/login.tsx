import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  KeyboardAvoidingView,
  ScrollView,
  Alert,
  ActivityIndicator,
  Image,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import * as AppleAuthentication from 'expo-apple-authentication';
import { supabase } from '../../supabase';
import { colors } from '../../lib/theme';

WebBrowser.maybeCompleteAuthSession();

const logoBlue = require('../../assets/images/ping-mark-blue.png');

export default function LoginScreen() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'ios') {
      AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
    }
  }, []);

  const handleEmailAuth = async () => {
    if (!email || !password) {
      Alert.alert('Missing info', 'Please enter an email and password.');
      return;
    }
    setLoading(true);

    // Email sign-ups were the one path that never asked for a name, so 26 of
    // 31 email accounts showed up nameless in guest lists (Apple and Google
    // always send one). Optional - App Review doesn't allow requiring it -
    // and NamePrompt reminds people later. AuthContext's ensureProfileName
    // copies this full_name onto the profile at first login.
    const signUpOptions = name.trim() ? { data: { full_name: name.trim() } } : undefined;

    const { error } = isSignUp
      ? await supabase.auth.signUp({ email, password, options: signUpOptions })
      : await supabase.auth.signInWithPassword({ email, password });

    setLoading(false);

    if (error) {
      Alert.alert(isSignUp ? 'Sign up failed' : 'Login failed', error.message);
      return;
    }

    if (isSignUp) {
      Alert.alert('Check your email', 'Confirm your account, then log in.');
      setIsSignUp(false);
    }
  };

  const handleGoogleLogin = async () => {
    setGoogleLoading(true);

    // Uses the app's own custom URL scheme (set in app.json) rather than
    // Expo's auth proxy. Only works in a custom dev client / standalone
    // build, NOT in Expo Go — see eas.json for the build profiles.
    const redirectUri = AuthSession.makeRedirectUri({
      scheme: 'pingapp',
      path: 'auth/callback',
    });

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectUri,
        skipBrowserRedirect: true,
      },
    });

    if (error || !data?.url) {
      setGoogleLoading(false);
      Alert.alert('Google sign-in failed', error?.message ?? 'Unknown error');
      return;
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectUri);

    if (result.type === 'success' && result.url) {
      const url = new URL(result.url.replace('#', '?'));
      const access_token = url.searchParams.get('access_token');
      const refresh_token = url.searchParams.get('refresh_token');

      if (access_token && refresh_token) {
        const { error: sessionError } = await supabase.auth.setSession({
          access_token,
          refresh_token,
        });
        if (sessionError) {
          Alert.alert('Google sign-in failed', sessionError.message);
        }
      }
    }

    setGoogleLoading(false);
  };

  const handleAppleLogin = async () => {
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });

      if (!credential.identityToken) {
        Alert.alert('Apple sign-in failed', 'No identity token returned.');
        return;
      }

      const { data, error } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: credential.identityToken,
      });

      if (error) {
        Alert.alert('Apple sign-in failed', error.message);
        return;
      }

      // Apple only ever includes the name in this first on-device
      // authorization response, never in the identity token itself — if we
      // don't capture it right here, it's gone for good on every later
      // sign-in for this Apple ID.
      const fullName = [credential.fullName?.givenName, credential.fullName?.familyName]
        .filter(Boolean)
        .join(' ');
      if (fullName && data.user) {
        const { data: existing } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('id', data.user.id)
          .maybeSingle();
        if (!existing?.full_name) {
          await supabase.from('profiles').update({ full_name: fullName }).eq('id', data.user.id);
        }
      }
    } catch (err: any) {
      // Apple's own picker throws this when the user dismisses it — not a
      // real failure, so don't surface an alert for it.
      if (err.code === 'ERR_REQUEST_CANCELED') return;
      Alert.alert('Apple sign-in failed', err?.message ?? 'Unknown error');
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
      <Image source={logoBlue} style={styles.logo} resizeMode="contain" />
      {/* The mark is icon-only (the old logo spelled out "Ping"), so the name
          is set as text under it. */}
      <Text style={styles.wordmark}>Ping</Text>
      <Text style={styles.subheader}>{isSignUp ? 'Create an account' : 'Welcome back'}</Text>

      {appleAvailable && (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={10}
          style={styles.appleButton}
          onPress={handleAppleLogin}
        />
      )}

      <TouchableOpacity
        style={styles.googleButton}
        onPress={handleGoogleLogin}
        disabled={googleLoading}
      >
        {googleLoading ? (
          <ActivityIndicator color={colors.textPrimary} />
        ) : (
          <Text style={styles.googleButtonText}>Continue with Google</Text>
        )}
      </TouchableOpacity>

      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.dividerLine} />
      </View>

      {isSignUp && (
        <TextInput
          style={styles.input}
          placeholder="Your name (optional)"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="words"
          textContentType="name"
          autoComplete="name"
          value={name}
          onChangeText={setName}
        />
      )}
      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor={colors.textMuted}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      <TouchableOpacity style={styles.primaryButton} onPress={handleEmailAuth} disabled={loading}>
        <Text style={styles.primaryButtonText}>
          {loading ? 'Please wait...' : isSignUp ? 'Sign Up' : 'Log In'}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => setIsSignUp(!isSignUp)}>
        <Text style={styles.switchText}>
          {isSignUp ? 'Already have an account? Log in' : "Don't have an account? Sign up"}
        </Text>
      </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: colors.background, padding: 24, justifyContent: 'center' },
  logo: { width: 72, height: 72, alignSelf: 'center', marginBottom: 8 },
  wordmark: { color: colors.textPrimary, fontSize: 34, fontWeight: '800', textAlign: 'center', marginBottom: 4 },
  subheader: { color: colors.textSecondary, fontSize: 16, textAlign: 'center', marginBottom: 32 },
  appleButton: { height: 48, marginBottom: 12 },
  googleButton: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  googleButtonText: { color: colors.textPrimary, fontWeight: '600', fontSize: 15 },
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 20 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.divider },
  dividerText: { color: colors.textMuted, marginHorizontal: 10, fontSize: 13 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 14,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    marginBottom: 12,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryButtonText: { color: colors.textOnPrimary, fontWeight: '700', fontSize: 15 },
  switchText: { color: colors.textSecondary, textAlign: 'center', marginTop: 20, fontSize: 14 },
});
