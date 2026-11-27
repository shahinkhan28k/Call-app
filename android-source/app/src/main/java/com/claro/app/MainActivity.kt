package com.claro.app

import android.app.Application
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Contacts
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import com.google.firebase.FirebaseApp

class ClaroApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        FirebaseApp.initializeApp(this)
    }
}

private val ModernBlue = Color(0xFF2563EB)

private val LightColors = lightColorScheme(
    primary = ModernBlue,
    onPrimary = Color.White,
    background = Color(0xFFFFFFFF),
    surface = Color(0xFFF8FAFC),
    onBackground = Color(0xFF0F172A),
    onSurface = Color(0xFF0F172A)
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF3B82F6),
    onPrimary = Color.White,
    background = Color(0xFF0B1120),
    surface = Color(0xFF111827),
    onBackground = Color(0xFFF8FAFC),
    onSurface = Color(0xFFF8FAFC)
)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val darkTheme = isSystemInDarkTheme()
            MaterialTheme(colorScheme = if (darkTheme) DarkColors else LightColors) {
                ClaroHomeShell()
            }
        }
    }
}

@Composable
fun ClaroHomeShell() {
    var selectedTab by remember { mutableIntStateOf(0) }
    val tabs = listOf(
        "Chats" to Icons.Default.ChatBubble,
        "Calls" to Icons.Default.Call,
        "Contacts" to Icons.Default.Contacts,
        "Settings" to Icons.Default.Settings
    )

    Scaffold(
        bottomBar = {
            NavigationBar {
                tabs.forEachIndexed { index, (label, icon) ->
                    NavigationBarItem(
                        selected = selectedTab == index,
                        onClick = { selectedTab = index },
                        icon = { Icon(icon, contentDescription = label) },
                        label = { Text(label) }
                    )
                }
            }
        }
    ) { padding ->
        Surface(modifier = Modifier.padding(padding)) {
            when (selectedTab) {
                0 -> Text("Chats — Connected to Firestore /chats")
                1 -> Text("Calls — Connected to WebRTC /calls")
                2 -> Text("Contacts — Search /userDirectory")
                3 -> Text("Settings — Privacy, Theme, Security")
            }
        }
    }
}
