package com.claro.app.webrtc

import android.content.Context
import org.webrtc.*

class WebRtcManager(
    private val context: Context,
    private val eglBase: EglBase = EglBase.create()
) {
    private val factory: PeerConnectionFactory
    private var peerConnection: PeerConnection? = null
    private var videoCapturer: CameraVideoCapturer? = null
    private var localAudioTrack: AudioTrack? = null
    private var localVideoTrack: VideoTrack? = null

    init {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .createInitializationOptions()
        )
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
    }

    fun startPeerConnection(
        iceServers: List<PeerConnection.IceServer>,
        isVideo: Boolean,
        localRenderer: SurfaceViewRenderer?,
        onIceCandidate: (IceCandidate) -> Unit,
        onRemoteTrack: (MediaStreamTrack) -> Unit
    ) {
        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }

        peerConnection = factory.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) = onIceCandidate(candidate)
            override fun onTrack(transceiver: RtpTransceiver?) {
                transceiver?.receiver?.track()?.let(onRemoteTrack)
            }
            override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(p0: PeerConnection.IceConnectionState?) {}
            override fun onIceConnectionReceivingChange(p0: Boolean) {}
            override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
            override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
            override fun onAddStream(p0: MediaStream?) {}
            override fun onRemoveStream(p0: MediaStream?) {}
            override fun onDataChannel(p0: DataChannel?) {}
            override fun onRenegotiationNeeded() {}
        })

        val audioSource = factory.createAudioSource(MediaConstraints())
        localAudioTrack = factory.createAudioTrack("CLARO_AUDIO", audioSource)
        peerConnection?.addTrack(localAudioTrack)

        if (isVideo && localRenderer != null) {
            val enumerator = Camera2Enumerator(context)
            val frontCam = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) }
                ?: enumerator.deviceNames.firstOrNull()
            if (frontCam != null) {
                videoCapturer = enumerator.createCapturer(frontCam, null)
                val surfaceHelper = SurfaceTextureHelper.create("CaptureThread", eglBase.eglBaseContext)
                val videoSource = factory.createVideoSource(videoCapturer!!.isScreencast)
                videoCapturer?.initialize(surfaceHelper, context, videoSource.capturerObserver)
                videoCapturer?.startCapture(1280, 720, 30)
                localVideoTrack = factory.createVideoTrack("CLARO_VIDEO", videoSource)
                localVideoTrack?.addSink(localRenderer)
                peerConnection?.addTrack(localVideoTrack)
            }
        }
    }

    fun switchCamera() {
        videoCapturer?.switchCamera(null)
    }

    fun setMicMuted(muted: Boolean) {
        localAudioTrack?.setEnabled(!muted)
    }

    fun setVideoEnabled(enabled: Boolean) {
        localVideoTrack?.setEnabled(enabled)
    }

    fun dispose() {
        videoCapturer?.stopCapture()
        videoCapturer?.dispose()
        peerConnection?.close()
        factory.dispose()
    }
}
